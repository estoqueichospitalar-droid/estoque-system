import { useMemo, useState } from 'react';
import { gerarOrdemCompraPdf, baixarPdf, carregarLogoPdf } from '../lib/ordemCompraPdf';
import { opcoesUnidade, unidadePadrao } from '../lib/unidades';
import { criarPedido } from '../lib/historicoPedidos';
import { getConfigProduto, salvarConfigProduto } from '../lib/configProdutos';
import { listarVinculos, listarFornecedores, marcarDisponibilidade, calcularModalidadeFrete, vincularProdutoFornecedor } from '../lib/fornecedores';

function fmtMoeda(v) {
  return `R$ ${(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MANUAL = '__manual__';

/** Fornecedores já vinculados a esse código específico, disponíveis e ativos, ordenados do mais barato pro mais caro. */
function opcoesFornecedor(codigo, vinculos, fornecedores) {
  return vinculos
    .filter((v) => v.codigo === codigo && v.disponivel)
    .map((v) => ({ vinculo: v, fornecedor: fornecedores.find((f) => f.id === v.fornecedorId) }))
    .filter((x) => x.fornecedor?.ativo)
    .sort((a, b) => (a.vinculo.custoUnitario ?? Infinity) - (b.vinculo.custoUnitario ?? Infinity));
}

/**
 * Todos os fornecedores ativos cadastrados, menos os já vinculados a esse
 * código (que aparecem no grupo acima) — separados em "mesmo setor do
 * produto" e "demais", pra facilitar achar quem provavelmente atende esse
 * item mesmo sem vínculo ainda registrado. Escolher um daqui cria o
 * vínculo na hora (ver handleEscolherFornecedor), então da próxima vez
 * que esse produto aparecer numa ordem, ele já vem no primeiro grupo.
 */
function demaisFornecedores(setorDoItem, jaVinculadosIds, fornecedores) {
  const restantes = fornecedores.filter((f) => f.ativo && !jaVinculadosIds.has(f.id));
  const doSetor = restantes.filter((f) => f.setor && f.setor === setorDoItem).sort((a, b) => a.nome.localeCompare(b.nome));
  const outros = restantes.filter((f) => !(f.setor && f.setor === setorDoItem)).sort((a, b) => a.nome.localeCompare(b.nome));
  return { doSetor, outros };
}

export default function OrdemCompra({
  selecionados, onRemoverSelecao, onPedidoCriado,
  campos, onCampos, observacoes, onObservacoes,
  rascunhoSalvoEm, onSalvarRascunho, onDescartarRascunho,
}) {
  const itens = Object.values(selecionados);
  const [vinculos, setVinculos] = useState(() => listarVinculos());
  const [fornecedores] = useState(() => listarFornecedores());
  const [gerando, setGerando] = useState(false);
  const [fornecedorUnico, setFornecedorUnico] = useState('');
  const [somenteSemFornecedor, setSomenteSemFornecedor] = useState(false);

  // Valor inicial de cada item (melhor fornecedor vinculado, custo, quantidade
  // sugerida). O que o usuário editou fica em `campos` (vive em App.jsx e é
  // gravado como rascunho) e prevalece sobre isto.
  const padroes = useMemo(() => {
    const iniciais = {};
    for (const item of Object.values(selecionados)) {
      const cfg = getConfigProduto(item.codigo);
      const melhor = opcoesFornecedor(item.codigo, vinculos, fornecedores)[0];
      iniciais[item.codigo] = {
        qtd: item.alerta?.quantidadeSugerida ?? 1,
        unidade: unidadePadrao(item.unidade),
        fornecedorId: melhor?.fornecedor.id ?? null,
        fornecedorTexto: melhor ? '' : (cfg?.fornecedor ?? ''),
        custoUnit: melhor ? (melhor.vinculo.custoUnitario ?? item.precoCusto ?? 0) : (item.precoCusto ?? 0),
      };
    }
    return iniciais;
  }, [selecionados, vinculos, fornecedores]);

  const campoDoCodigo = (codigo) => ({ ...padroes[codigo], ...(campos[codigo] ?? {}) });

  function mesclarCampos(codigo, parcial) {
    onCampos((c) => ({ ...c, [codigo]: { ...padroes[codigo], ...(c[codigo] ?? {}), ...parcial } }));
  }

  function atualizarCampo(codigo, campo, valor) {
    mesclarCampos(codigo, { [campo]: valor });
  }

  /**
   * "Fornecedor único": a ordem inteira vai pra um fornecedor só. Não cria
   * vínculo produto↔fornecedor (isso é decisão item a item, no seletor de
   * cada linha) — só define pra quem esta ordem é emitida. Custo e quantidade
   * de cada item ficam como estão.
   */
  function aplicarFornecedorUnico() {
    if (!fornecedorUnico) return;
    const alvo = itens.filter((item) => !somenteSemFornecedor || !campoDoCodigo(item.codigo).fornecedorId);
    if (alvo.length === 0) {
      window.alert('Todos os itens já têm fornecedor. Desmarque "Só nos itens sem fornecedor" para trocar o de todos.');
      return;
    }
    const trocando = alvo.filter((item) => {
      const c = campoDoCodigo(item.codigo);
      return c.fornecedorId && c.fornecedorId !== fornecedorUnico;
    }).length;
    if (trocando > 0 && !window.confirm(`${trocando} item(ns) já têm outro fornecedor e serão trocados. Continuar?`)) return;
    onCampos((c) => {
      const novo = { ...c };
      for (const item of alvo) {
        novo[item.codigo] = { ...padroes[item.codigo], ...(c[item.codigo] ?? {}), fornecedorId: fornecedorUnico, fornecedorTexto: '' };
      }
      return novo;
    });
  }

  /**
   * "Esse fornecedor não tem esse item" — marca o vínculo como indisponível
   * (fica registrado no cadastro, não sugere mais esse par de novo) e
   * reatribui o item pro próximo fornecedor cadastrado mais barato, se
   * houver. Não afeta os outros itens do mesmo fornecedor — o resto do
   * pedido dele segue normalmente, é só esse item que muda de grupo.
   */
  function marcarItemIndisponivel(codigo, fornecedorId) {
    marcarDisponibilidade(codigo, fornecedorId, false);
    const vinculosAtualizados = listarVinculos();
    setVinculos(vinculosAtualizados);
    const proximo = opcoesFornecedor(codigo, vinculosAtualizados, fornecedores)[0];
    const custoAtual = campoDoCodigo(codigo).custoUnit;
    mesclarCampos(codigo, {
      fornecedorId: proximo?.fornecedor.id ?? null,
      custoUnit: proximo ? (proximo.vinculo.custoUnitario ?? custoAtual) : custoAtual,
    });
    window.alert(
      proximo
        ? `Marcado como indisponível. Reatribuído para "${proximo.fornecedor.nome}" (o resto do pedido anterior não é afetado).`
        : 'Marcado como indisponível. Não há outro fornecedor cadastrado pra esse item — ficará em "A definir" até cadastrar um novo, na aba Fornecedores.'
    );
  }

  const grupos = useMemo(() => {
    const mapa = new Map();
    for (const item of Object.values(selecionados)) {
      const c = campoDoCodigo(item.codigo);
      const fornecedorCadastrado = c.fornecedorId ? fornecedores.find((f) => f.id === c.fornecedorId) : null;
      const nomeFornecedor = fornecedorCadastrado?.nome ?? (c.fornecedorTexto?.trim() || 'A definir');
      if (!mapa.has(nomeFornecedor)) mapa.set(nomeFornecedor, { itens: [], fornecedorCadastrado });
      mapa.get(nomeFornecedor).itens.push({
        codigo: item.codigo,
        descricao: item.descricao,
        unidade: c.unidade,
        qtd: Number(c.qtd) || 0,
        custoUnit: Number(c.custoUnit) || 0,
        nivel: item.alerta?.nivel,
      });
    }
    return Array.from(mapa.entries()).map(([fornecedor, dados]) => ({ fornecedor, ...dados }));
  }, [selecionados, campos, padroes, fornecedores]);

  const valorTotal = grupos.reduce(
    (s, g) => s + g.itens.reduce((s2, i) => s2 + i.qtd * i.custoUnit, 0),
    0
  );

  async function handleGerarPdf() {
    setGerando(true);
    try {
      // Quando o fornecedor foi digitado à mão (ainda não cadastrado na aba
      // Fornecedores), guarda como preferência futura do produto — se já veio
      // do cadastro, o cadastro em si já é a fonte da verdade, não precisa duplicar.
      for (const item of itens) {
        const c = campoDoCodigo(item.codigo);
        if (!c?.fornecedorId && c?.fornecedorTexto?.trim()) {
          salvarConfigProduto(item.codigo, { fornecedor: c.fornecedorTexto.trim() });
        }
      }

      const logoBytes = await carregarLogoPdf();

      const bytes = await gerarOrdemCompraPdf({
        grupos,
        referencia: `Ordem de compra — ${new Date().toLocaleDateString('pt-BR')}`,
        logoBytes,
        observacoes: observacoes.trim() || null,
      });
      baixarPdf(bytes, `ordem-de-compra-ic-supra-${Date.now()}.pdf`);

      // registra no histórico, um pedido por fornecedor (a observação vale
      // pra ordem inteira, então fica salva em cada pedido gerado por ela)
      for (const grupo of grupos) {
        const pedido = criarPedido({
          fornecedor: grupo.fornecedor,
          itens: grupo.itens.map((i) => ({
            codigo: i.codigo, descricao: i.descricao, unidade: i.unidade, qtdPedida: i.qtd, custoUnit: i.custoUnit,
          })),
          observacoes: observacoes.trim() || null,
        });
        onPedidoCriado?.(pedido);
      }
    } catch (e) {
      console.error(e);
      alert('Não foi possível gerar o PDF. Veja o console para detalhes.');
    } finally {
      setGerando(false);
    }
  }

  if (itens.length === 0) {
    return (
      <div className="vazio">
        Nenhum item selecionado. Vá para <strong>Alertas de Compra</strong> e marque os produtos que deseja incluir.
      </div>
    );
  }

  return (
    <div>
      <h2>Montar ordem de compra</h2>
      <p className="subtitulo-pagina">
        Ajuste quantidade, custo e fornecedor de cada item. O PDF final é segmentado por fornecedor.
      </p>

      <div className="card" style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Fornecedor único</strong>
        <select value={fornecedorUnico} onChange={(e) => setFornecedorUnico(e.target.value)} style={{ minWidth: 240 }}>
          <option value="">Escolha o fornecedor da ordem inteira…</option>
          {fornecedores.filter((f) => f.ativo).sort((a, b) => a.nome.localeCompare(b.nome)).map((f) => (
            <option key={f.id} value={f.id}>{f.nome}</option>
          ))}
        </select>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={somenteSemFornecedor} onChange={(e) => setSomenteSemFornecedor(e.target.checked)} />
          Só nos itens sem fornecedor
        </label>
        <button className="btn" disabled={!fornecedorUnico} onClick={aplicarFornecedorUnico}>
          Aplicar a todos os itens ({itens.length})
        </button>
        <span style={{ fontSize: 11, color: 'var(--muted)', flexBasis: '100%' }}>
          Preenche o fornecedor de todas as linhas de uma vez. Custo e quantidade de cada item não mudam, e não cria vínculo produto↔fornecedor.
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Código</th>
            <th>Descrição</th>
            <th>Un.</th>
            <th>Qtd.</th>
            <th>Custo Un. (R$)</th>
            <th>Fornecedor</th>
            <th>Subtotal</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {itens.map((item) => {
            const c = campoDoCodigo(item.codigo);
            const subtotal = (Number(c.qtd) || 0) * (Number(c.custoUnit) || 0);
            const opcoes = opcoesFornecedor(item.codigo, vinculos, fornecedores);
            const jaVinculadosIds = new Set(opcoes.map((o) => o.fornecedor.id));
            const { doSetor, outros } = demaisFornecedores(item.setor, jaVinculadosIds, fornecedores);
            const usandoManual = !c.fornecedorId;
            return (
              <tr key={item.codigo}>
                <td>{item.codigo}</td>
                <td>{item.descricao}</td>
                <td>
                  <select value={c.unidade} style={{ width: 92 }} title="Unidade em que este item será pedido"
                    onChange={(e) => atualizarCampo(item.codigo, 'unidade', e.target.value)}>
                    {opcoesUnidade(c.unidade).map((u) => <option key={u.sigla} value={u.sigla}>{u.sigla} — {u.nome}</option>)}
                  </select>
                </td>
                <td>
                  <input type="number" min="0" value={c.qtd} style={{ width: 70 }}
                    onChange={(e) => atualizarCampo(item.codigo, 'qtd', e.target.value)} />
                </td>
                <td>
                  <input type="number" min="0" step="0.01" value={c.custoUnit} style={{ width: 90 }}
                    onChange={(e) => atualizarCampo(item.codigo, 'custoUnit', e.target.value)} />
                </td>
                <td>
                  <select
                    value={usandoManual ? MANUAL : c.fornecedorId}
                    style={{ width: 170 }}
                    onChange={(e) => {
                      if (e.target.value === MANUAL) {
                        atualizarCampo(item.codigo, 'fornecedorId', null);
                        return;
                      }
                      const fornecedorId = e.target.value;
                      const jaVinculado = opcoes.find((o) => o.fornecedor.id === fornecedorId);
                      if (jaVinculado) {
                        mesclarCampos(item.codigo, {
                          fornecedorId,
                          custoUnit: jaVinculado.vinculo.custoUnitario ?? c.custoUnit,
                        });
                      } else {
                        // Fornecedor cadastrado mas ainda sem vínculo com esse
                        // produto — cria o vínculo na hora, com o custo já
                        // digitado na linha, pra da próxima vez já aparecer
                        // no grupo "vinculados a este produto".
                        vincularProdutoFornecedor(item.codigo, fornecedorId, { custoUnitario: Number(c.custoUnit) || null, disponivel: true });
                        setVinculos(listarVinculos());
                        atualizarCampo(item.codigo, 'fornecedorId', fornecedorId);
                      }
                    }}
                  >
                    {opcoes.length > 0 && (
                      <optgroup label="Vinculados a este produto">
                        {opcoes.map((o) => (
                          <option key={o.fornecedor.id} value={o.fornecedor.id}>
                            {o.fornecedor.nome} {o.vinculo.custoUnitario != null ? `(R$ ${o.vinculo.custoUnitario})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {doSetor.length > 0 && (
                      <optgroup label={`Fornecedores de ${item.setor}`}>
                        {doSetor.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                      </optgroup>
                    )}
                    {outros.length > 0 && (
                      <optgroup label="Outros fornecedores cadastrados">
                        {outros.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                      </optgroup>
                    )}
                    <option value={MANUAL}>Outro (digitar)…</option>
                  </select>
                  {usandoManual && (
                    <input
                      type="text"
                      placeholder="Nome do fornecedor"
                      value={c.fornecedorTexto ?? ''}
                      style={{ width: 170, marginTop: 4 }}
                      onChange={(e) => atualizarCampo(item.codigo, 'fornecedorTexto', e.target.value)}
                    />
                  )}
                  {!usandoManual && (
                    <button
                      className="btn secundario pequeno"
                      style={{ marginTop: 4 }}
                      title="Esse fornecedor não tem esse item — reatribui pro próximo disponível, sem afetar o resto do pedido dele"
                      onClick={() => marcarItemIndisponivel(item.codigo, c.fornecedorId)}
                    >
                      Indisponível aqui
                    </button>
                  )}
                </td>
                <td>R$ {subtotal.toFixed(2).replace('.', ',')}</td>
                <td>
                  <button className="btn secundario pequeno" onClick={() => onRemoverSelecao(item.codigo)}>Remover</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Resumo por fornecedor</h3>
        {grupos.map((g) => {
          const totalGrupo = g.itens.reduce((s, i) => s + i.qtd * i.custoUnit, 0);
          const fc = g.fornecedorCadastrado;
          const frete = fc ? calcularModalidadeFrete(fc, totalGrupo) : null;
          const excedeCredito = fc?.limiteCredito != null && totalGrupo > fc.limiteCredito;
          return (
            <div key={g.fornecedor} style={{ padding: '8px 0', borderBottom: '1px solid var(--cinza-borda)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>{g.fornecedor} ({g.itens.length} item(ns))</span>
                <strong>{fmtMoeda(totalGrupo)}</strong>
              </div>
              {fc && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  Prazo: {fc.prazoPagamentoDias ? `${fc.prazoPagamentoDias} dias` : 'não definido'}
                  {frete && ` · Frete: ${frete}`}
                </div>
              )}
              {excedeCredito && (
                <div style={{ fontSize: 11, color: 'var(--vermelho)', marginTop: 2, fontWeight: 600 }}>
                  ⚠ Total ({fmtMoeda(totalGrupo)}) excede o limite de crédito cadastrado para este fornecedor ({fmtMoeda(fc.limiteCredito)}).
                </div>
              )}
            </div>
          );
        })}
        <div style={{ marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--azul)' }}>
          <span>Total geral</span>
          <span>{fmtMoeda(valorTotal)}</span>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Observações</h3>
        <textarea
          value={observacoes}
          onChange={(e) => onObservacoes(e.target.value)}
          placeholder="Descrição livre — combinação com o fornecedor, urgência, prazo de entrega, etc. Entra no PDF e fica salva no histórico do pedido."
          rows={3}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      <div className="rodape-acoes" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" disabled={gerando} onClick={handleGerarPdf}>
          {gerando ? 'Gerando PDF…' : '📄 Gerar PDF da ordem de compra'}
        </button>
        <button className="btn secundario" onClick={onSalvarRascunho}>💾 Salvar rascunho</button>
        <button
          className="btn secundario"
          onClick={() => { if (window.confirm('Descartar esta ordem em andamento (itens, quantidades, fornecedores e observações)?')) onDescartarRascunho(); }}
        >
          Descartar rascunho
        </button>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {rascunhoSalvoEm
            ? `Rascunho salvo automaticamente às ${new Date(rascunhoSalvoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (neste navegador)`
            : 'O rascunho é salvo automaticamente neste navegador'}
        </span>
      </div>
    </div>
  );
}
