import { Fragment, useEffect, useMemo, useState } from 'react';
import { getUltimoSnapshot } from '../lib/historicoPedidos';
import { gerarPainelAlertas } from '../lib/alertas';
import { getConfigProduto, salvarConfigProduto, importarConfigsEmLote } from '../lib/configProdutos';
import { inferirSetor, SETORES, SETORES_NAO_DESCONTINUAVEIS, SETORES_FLAG_GESTAO } from '../lib/setores';
import TagAlerta from './TagAlerta';

function fmtMoeda(v) {
  return `R$ ${(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const COR_CURVA_ABC = { A: 'var(--vermelho)', B: 'var(--amarelo)', C: 'var(--muted)' };

function TagAbc({ classe }) {
  return (
    <span
      className="tag"
      style={{ color: COR_CURVA_ABC[classe] ?? 'var(--muted)', background: 'var(--cinza)' }}
      title="Curva ABC por valor, calculada dentro do próprio setor: A = maior impacto no setor (até 80% do valor acumulado), B = até 95%, C = o resto."
    >
      {classe}
    </span>
  );
}

const ORDENACOES = [
  { chave: 'URGENCIA', label: 'Ordenar por urgência' },
  { chave: 'FATURAMENTO', label: 'Ordenar por impacto no faturamento' },
];

/** "⚑ Fora da linha atual — decisão da gestão", usada tanto no cabeçalho do setor quanto na linha do item. */
function FlagGestao() {
  return (
    <span
      title="Setor fora da linha atual de comercialização — decisão de voltar a vender ou não é da gestão, não do sistema."
      style={{ color: 'var(--amarelo)', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      ⚑ Fora da linha atual — decisão da gestão
    </span>
  );
}

const FILTROS_NIVEL = [
  { chave: 'TODOS', label: 'Todos' },
  { chave: 'NEGATIVO', label: 'Estoque negativo' },
  { chave: 'RUPTURA', label: 'Ruptura (zerado)' },
  { chave: 'CRITICO', label: 'Crítico' },
  { chave: 'ATENCAO', label: 'Atenção' },
  { chave: 'MONITORAR', label: 'Monitorar' },
  { chave: 'OK', label: 'Estoque OK' },
];

const OPCOES_QUANTIDADE = [
  { valor: 0, label: 'Todos' },
  { valor: 5, label: 'Top 5 por setor' },
  { valor: 10, label: 'Top 10 por setor' },
  { valor: 15, label: 'Top 15 por setor' },
  { valor: 20, label: 'Top 20 por setor' },
  { valor: 50, label: 'Top 50 por setor' },
];

const TOTAL_COLUNAS = 15;

function LinhaConfig({ item, onSalvar, onCancelar }) {
  const cfg = getConfigProduto(item.codigo) ?? {};
  const [estoqueMinimo, setEstoqueMinimo] = useState(cfg.estoqueMinimo ?? '');
  const [giroSemanal, setGiroSemanal] = useState(cfg.giroSemanal ?? '');
  const [leadTimeDias, setLeadTimeDias] = useState(cfg.leadTimeDias ?? '');
  const [fornecedor, setFornecedor] = useState(cfg.fornecedor ?? '');
  const [setor, setSetor] = useState(cfg.setor ?? inferirSetor(item.descricao));

  return (
    <tr>
      <td colSpan={TOTAL_COLUNAS} style={{ background: 'var(--azul-claro)' }}>
        <div className="linha-flex" style={{ flexWrap: 'wrap', gap: 12, padding: '6px 0' }}>
          <label style={{ fontSize: 11 }} title="🔄 calculado automaticamente a partir do giro de vendas · ✋ ajustado manualmente">
            Estoque mínimo{cfg.estoqueMinimoOrigem === 'automatico' ? ' 🔄' : cfg.estoqueMinimoOrigem === 'manual' ? ' ✋' : ''}{' '}
            <input type="number" value={estoqueMinimo} onChange={(e) => setEstoqueMinimo(e.target.value)} style={{ width: 70 }} />
          </label>
          <label style={{ fontSize: 11 }}>
            Giro semanal (un.){cfg.giroOrigem === 'automatico' ? ' 🔄' : cfg.giroOrigem === 'manual' ? ' ✋' : ''}{' '}
            <input type="number" value={giroSemanal} onChange={(e) => setGiroSemanal(e.target.value)} style={{ width: 70 }} />
          </label>
          <label style={{ fontSize: 11 }}>
            Lead time fornecedor (dias){' '}
            <input type="number" value={leadTimeDias} onChange={(e) => setLeadTimeDias(e.target.value)} style={{ width: 70 }} />
          </label>
          <label style={{ fontSize: 11 }}>
            Fornecedor (texto livre — cadastro completo com custo fica na aba Fornecedores){' '}
            <input type="text" value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} style={{ width: 140 }} />
          </label>
          <label style={{ fontSize: 11 }}>
            Setor{' '}
            <select value={setor} onChange={(e) => setSetor(e.target.value)}>
              {SETORES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button
            className="btn pequeno"
            onClick={() => {
              salvarConfigProduto(item.codigo, {
                estoqueMinimo: estoqueMinimo === '' ? null : Number(estoqueMinimo),
                estoqueMinimoOrigem: estoqueMinimo === '' ? null : 'manual',
                giroSemanal: giroSemanal === '' ? null : Number(giroSemanal),
                giroOrigem: giroSemanal === '' ? null : 'manual',
                leadTimeDias: leadTimeDias === '' ? null : Number(leadTimeDias),
                fornecedor: fornecedor || null,
                setor,
              });
              onSalvar();
            }}
          >
            Salvar
          </button>
          <button className="btn secundario pequeno" onClick={onCancelar}>Cancelar</button>
        </div>
      </td>
    </tr>
  );
}

function LinhaItem({ item, selecionado, onAlternarSelecao, editando, setEditando }) {
  return (
    <Fragment>
      <tr>
        <td>
          <input
            type="checkbox"
            checked={!!selecionado}
            onChange={() => onAlternarSelecao(item)}
          />
        </td>
        <td>{item.codigo}</td>
        <td>{item.descricao}</td>
        <td>{item.unidade || '-'}</td>
        <td>{item.quantidade}</td>
        <td>{item.estoqueMinimo ?? '—'}</td>
        <td>{item.alerta.pontoPedido != null ? Math.ceil(item.alerta.pontoPedido) : '—'}</td>
        <td>{item.alerta.diasCobertura != null ? item.alerta.diasCobertura.toFixed(1) : '—'}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {item.vendaRecente
            ? <span title={`${item.vendaRecente.qtdeVolumes.toLocaleString('pt-BR')} un. vendidas nos meses importados`}>{fmtMoeda(item.vendaRecente.totVendas)}</span>
            : <span style={{ color: 'var(--muted)' }}>—</span>}
        </td>
        <td><TagAbc classe={item.curvaAbc} /></td>
        <td><TagAlerta nivel={item.alerta.nivel} /></td>
        <td style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 220 }}>{item.alerta.motivo}</td>
        <td style={{ fontSize: 11 }}>{item.fornecedor ?? <span style={{ color: 'var(--muted)' }}>—</span>}</td>
        <td>{item.precisaFlagGestao && <FlagGestao />}</td>
        <td>
          <button className="btn secundario pequeno" onClick={() => setEditando(editando === item.codigo ? null : item.codigo)}>
            {editando === item.codigo ? 'Fechar' : 'Configurar'}
          </button>
        </td>
      </tr>
      {editando === item.codigo && (
        <LinhaConfig
          item={item}
          onSalvar={() => setEditando(null)}
          onCancelar={() => setEditando(null)}
        />
      )}
    </Fragment>
  );
}

export default function PainelAlertas({ snapshot, selecionados, onAlternarSelecao, onIrParaOrdem }) {
  const atual = snapshot ?? getUltimoSnapshot();
  const [filtroNivel, setFiltroNivel] = useState('TODOS');
  const [filtroSetor, setFiltroSetor] = useState([]); // [] = todos os setores; clique em várias pílulas marca vários
  const [filtroAbc, setFiltroAbc] = useState('TODOS');
  const [ordenacao, setOrdenacao] = useState('URGENCIA');
  const [limite, setLimite] = useState(0);
  const [busca, setBusca] = useState('');
  const [editando, setEditando] = useState(null);
  const [versao, setVersao] = useState(0); // força recálculo do setor após salvar config
  const [setoresFechados, setSetoresFechados] = useState(() => new Set());

  const painel = useMemo(() => {
    if (!atual) return [];
    return gerarPainelAlertas(atual.itens);
  }, [atual, versao]);

  const contagensNivel = useMemo(() => {
    const c = { NEGATIVO: 0, RUPTURA: 0, CRITICO: 0, ATENCAO: 0, MONITORAR: 0, OK: 0 };
    for (const item of painel) if (c[item.alerta.nivel] !== undefined) c[item.alerta.nivel] += 1;
    return c;
  }, [painel]);

  const setoresDisponiveis = useMemo(() => {
    const presentes = new Set(painel.map((i) => i.setor));
    return SETORES.filter((s) => presentes.has(s));
  }, [painel]);

  const listaFiltrada = useMemo(() => {
    let lista = painel;
    if (filtroNivel !== 'TODOS') lista = lista.filter((i) => i.alerta.nivel === filtroNivel);
    // "Todos" = tudo que precisa de atenção — mas quem está buscando um
    // produto específico quer achá-lo mesmo com estoque confortável (ex: pra
    // incluir num pedido por conta própria), então a busca vale pro catálogo inteiro.
    else if (!busca.trim()) lista = lista.filter((i) => i.alerta.nivel !== 'OK');
    if (filtroSetor.length > 0) lista = lista.filter((i) => filtroSetor.includes(i.setor));
    if (filtroAbc !== 'TODOS') lista = lista.filter((i) => i.curvaAbc === filtroAbc);
    if (busca.trim()) {
      const b = busca.trim().toLowerCase();
      lista = lista.filter((i) => i.descricao.toLowerCase().includes(b) || i.codigo.includes(b));
    }
    if (ordenacao === 'FATURAMENTO') {
      lista = [...lista].sort((a, b) => (b.vendaRecente?.totVendas ?? 0) - (a.vendaRecente?.totVendas ?? 0));
    }
    return lista;
  }, [painel, filtroNivel, filtroSetor, filtroAbc, busca, ordenacao]);

  // Agrupa por setor ANTES de paginar — cada setor revela sua própria lista
  // em blocos, com seu próprio "carregar mais" (ver render abaixo). Assim
  // todo segmento chega até o fim, qualquer que seja o filtro usado — "Top
  // N por setor" não é mais um corte definitivo e sem volta, é só QUANTOS
  // itens aparecem de cada setor antes de precisar clicar em carregar mais
  // (ver PAGINA_SETOR abaixo). Sem isso, quem usasse Top 50 nunca conseguia
  // ver o item 51 em diante de um setor com centenas de itens.
  const gruposFiltrados = useMemo(() => {
    const mapa = new Map();
    for (const item of listaFiltrada) {
      if (!mapa.has(item.setor)) mapa.set(item.setor, []);
      mapa.get(item.setor).push(item);
    }
    // mantém a ordem já definida em listaFiltrada dentro do setor (urgência
    // ou impacto no faturamento, dependendo da ordenação escolhida)
    return Array.from(mapa.entries());
  }, [listaFiltrada]);

  // Renderizar milhares de <tr> de uma vez trava o navegador, então cada
  // setor revela sua lista em blocos — o cálculo acima já é rápido, o
  // gargalo é o DOM. Estado por setor: { [setor]: quantidade renderizada }.
  const PAGINA_SETOR = 50;
  const [renderizadosPorSetor, setRenderizadosPorSetor] = useState({});
  useEffect(() => { setRenderizadosPorSetor({}); }, [filtroNivel, filtroSetor, filtroAbc, busca, limite]);

  // Grupo COMPLETO por setor (não limitado pela paginação de renderização),
  // usado só para a ação em lote "marcar setor como descontinuado" — sem
  // isso, marcar um setor com 9 mil itens só afetaria os 200 na tela.
  const setorCompletoMapa = useMemo(() => {
    const mapa = new Map();
    for (const item of painel) {
      if (!mapa.has(item.setor)) mapa.set(item.setor, []);
      mapa.get(item.setor).push(item);
    }
    return mapa;
  }, [painel]);

  function alternarSetor(setor) {
    setSetoresFechados((s) => {
      const copia = new Set(s);
      if (copia.has(setor)) copia.delete(setor);
      else copia.add(setor);
      return copia;
    });
  }

  function expandirTodos() { setSetoresFechados(new Set()); }
  function retrairTodos() { setSetoresFechados(new Set(gruposFiltrados.map(([setor]) => setor))); }

  function marcarSetorComoDescontinuado(setor, itensDoSetor) {
    // Zerado no estoque significa "precisa comprar", nunca "descontinuar" —
    // qualquer item com venda registrada no Mix de Vendas é protegido e sai
    // do lote antes mesmo da confirmação, pra quem está clicando já ver o
    // impacto real da ação.
    const protegidos = itensDoSetor.filter((item) => item.vendaRecente);
    const candidatos = itensDoSetor.filter((item) => !item.vendaRecente);

    const confirmado = window.confirm(
      `Marcar ${candidatos.length} de ${itensDoSetor.length} item(ns) do setor "${setor}" como descontinuados?\n\n` +
      (protegidos.length > 0
        ? `${protegidos.length} item(ns) têm venda registrada no Mix de Vendas e serão mantidos ativos automaticamente — não entram no lote.\n\n`
        : '') +
      'Os demais vão parar de aparecer nos alertas de compra (mas continuam contados no estoque). ' +
      'Dá para desfazer depois, item por item, em "Configurar".'
    );
    if (!confirmado) return;
    const lote = {};
    for (const item of candidatos) lote[item.codigo] = { descontinuado: true };
    importarConfigsEmLote(lote);
    window.alert(
      `${candidatos.length} de ${itensDoSetor.length} itens marcados` +
      (protegidos.length > 0 ? ` — ${protegidos.length} tinham venda recente e foram mantidos ativos.` : '.')
    );
    setVersao((v) => v + 1);
  }

  if (!atual) {
    return <div className="vazio">Nenhuma análise gerada ainda. Importe os relatórios de estoque primeiro.</div>;
  }

  return (
    <div>
      <h2>Alertas de compra</h2>
      <p className="subtitulo-pagina">
        Lista priorizada, agrupada por setor — do mais urgente para o menos urgente. Selecione os itens e clique em{' '}
        <strong>Montar ordem de compra</strong>.
      </p>

      <div className="filtros">
        {FILTROS_NIVEL.map((f) => (
          <button key={f.chave} className={filtroNivel === f.chave ? 'active' : ''} onClick={() => setFiltroNivel(f.chave)}>
            {f.label} {f.chave !== 'TODOS' && contagensNivel[f.chave] ? `(${contagensNivel[f.chave]})` : ''}
          </button>
        ))}
      </div>

      <div className="filtros">
        <button className={filtroSetor.length === 0 ? 'active' : ''} onClick={() => setFiltroSetor([])}>
          Todos os setores
        </button>
        {setoresDisponiveis.map((s) => (
          <button
            key={s}
            className={filtroSetor.includes(s) ? 'active' : ''}
            onClick={() => setFiltroSetor((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="filtros">
        <select value={filtroAbc} onChange={(e) => setFiltroAbc(e.target.value)}>
          <option value="TODOS">Curva ABC (todas)</option>
          <option value="A">Curva A</option>
          <option value="B">Curva B</option>
          <option value="C">Curva C</option>
        </select>

        <select value={limite} onChange={(e) => setLimite(Number(e.target.value))}>
          {OPCOES_QUANTIDADE.map((o) => <option key={o.valor} value={o.valor}>{o.label}</option>)}
        </select>

        <select value={ordenacao} onChange={(e) => setOrdenacao(e.target.value)}>
          {ORDENACOES.map((o) => <option key={o.chave} value={o.chave}>{o.label}</option>)}
        </select>

        <button className="btn secundario pequeno" onClick={expandirTodos}>Expandir todos</button>
        <button className="btn secundario pequeno" onClick={retrairTodos}>Retrair todos</button>

        <input
          type="text"
          placeholder="Buscar por código ou descrição…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          style={{ marginLeft: 'auto', minWidth: 220 }}
        />
      </div>

      {busca.trim() && filtroNivel === 'TODOS' && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
          Busca em todo o estoque importado, inclusive itens com estoque OK (que não aparecem na lista sem busca).
        </p>
      )}

      {gruposFiltrados.length === 0 && <div className="vazio">Nenhum item nesse filtro.</div>}

      {gruposFiltrados.map(([setor, itensDoSetorFiltrados]) => {
        const aberto = !setoresFechados.has(setor);
        const totalNoSetor = setorCompletoMapa.get(setor)?.length ?? itensDoSetorFiltrados.length;
        const qtdRenderizada = renderizadosPorSetor[setor] ?? (limite > 0 ? limite : PAGINA_SETOR);
        const itensDoSetor = itensDoSetorFiltrados.slice(0, qtdRenderizada);
        const podeDescontinuar = !SETORES_NAO_DESCONTINUAVEIS.includes(setor);
        const precisaFlagGestao = SETORES_FLAG_GESTAO.includes(setor);
        return (
          <div className="setor-bloco" key={setor}>
            <div className="setor-header" onClick={() => alternarSetor(setor)}>
              <span className={`seta ${aberto ? 'aberto' : ''}`}>▶</span>
              {setor}
              {precisaFlagGestao && <FlagGestao />}
              <span className="contagem-setor">
                {itensDoSetorFiltrados.length > itensDoSetor.length
                  ? `${itensDoSetor.length} de ${itensDoSetorFiltrados.length}`
                  : (totalNoSetor > itensDoSetorFiltrados.length ? `${itensDoSetorFiltrados.length} de ${totalNoSetor}` : totalNoSetor)} item(ns)
              </span>
              {podeDescontinuar && (
                <button
                  className="btn secundario pequeno"
                  style={{ marginLeft: 12 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    marcarSetorComoDescontinuado(setor, setorCompletoMapa.get(setor) ?? itensDoSetorFiltrados);
                  }}
                >
                  Marcar setor como descontinuado
                </button>
              )}
            </div>
            {aberto && (
              <div className="tabela-scroll">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Código</th>
                    <th>Descrição</th>
                    <th>Un.</th>
                    <th>Estoque</th>
                    <th>Mínimo</th>
                    <th>Ponto de pedido</th>
                    <th>Cobertura (dias)</th>
                    <th>Faturamento recente</th>
                    <th>ABC</th>
                    <th>Nível</th>
                    <th>Motivo</th>
                    <th>Fornecedor</th>
                    <th></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {itensDoSetor.map((item) => (
                    <LinhaItem
                      key={item.codigo}
                      item={item}
                      selecionado={!!selecionados[item.codigo]}
                      onAlternarSelecao={onAlternarSelecao}
                      editando={editando}
                      setEditando={(v) => { setEditando(v); if (v === null) setVersao((n) => n + 1); }}
                    />
                  ))}
                </tbody>
              </table>
              </div>
            )}
            {aberto && itensDoSetorFiltrados.length > itensDoSetor.length && (
              <div className="resumo-arquivo" style={{ textAlign: 'left', padding: '8px 4px 0' }}>
                Mostrando {itensDoSetor.length} de {itensDoSetorFiltrados.length} itens deste setor —{' '}
                <button
                  className="btn secundario pequeno"
                  onClick={() => setRenderizadosPorSetor((r) => ({ ...r, [setor]: qtdRenderizada + PAGINA_SETOR }))}
                >
                  carregar mais {Math.min(PAGINA_SETOR, itensDoSetorFiltrados.length - itensDoSetor.length)}
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div className="rodape-acoes">
        <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>
          {Object.keys(selecionados).length} item(ns) selecionado(s)
        </span>
        <button className="btn" disabled={Object.keys(selecionados).length === 0} onClick={onIrParaOrdem}>
          Montar ordem de compra →
        </button>
      </div>
    </div>
  );
}
