import { useCallback, useEffect, useRef, useState } from 'react';
import { extrairTextoPdf } from '../lib/pdfExtract';
import { parseRelatorioEstoque, unificarSnapshot } from '../lib/parsers/estoqueParser';
import { salvarSnapshot } from '../lib/historicoPedidos';
import { buscarRelatoriosAnteriores } from '../lib/relatoriosAnteriores';

const TIPOS = [
  { chave: 'positivo', titulo: 'Estoque positivo', descricao: 'Itens de estoque atual (quantidade > 0)' },
  { chave: 'negativo', titulo: 'Estoque negativo', descricao: 'Itens de quantidade negativa (erro de contagem)' },
  { chave: 'zerado', titulo: 'Estoque zerado', descricao: 'Itens de quantidade zero (ruptura / sem giro)' },
];

function fmtMoeda(v) {
  const sinal = v < 0 ? '-' : '';
  return `${sinal}R$ ${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Dropzone({ tipo, arquivo, status, progresso, relatorio, onArquivo }) {
  const [arrastando, setArrastando] = useState(false);

  function handleDrop(e) {
    e.preventDefault();
    setArrastando(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onArquivo(tipo.chave, f);
  }

  const valorTotal = relatorio ? relatorio.itens.reduce((s, i) => s + i.total, 0) : null;

  return (
    <div className="dropzone-col">
      <label
        className={`dropzone ${arrastando ? 'arrastando' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
        onDragLeave={() => setArrastando(false)}
        onDrop={handleDrop}
      >
        <div className="dz-titulo">{tipo.titulo}</div>
        <div className="dz-descricao">{tipo.descricao}</div>
        <div className="dz-arquivo">
          {arquivo ? `📄 ${arquivo.name}` : 'Arraste o PDF aqui ou clique para selecionar'}
        </div>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => e.target.files?.[0] && onArquivo(tipo.chave, e.target.files[0])}
        />
      </label>

      {status === 'processando' && (
        <div className="status-arquivo pendente">
          Lendo PDF… {progresso ? `página ${progresso.atual}/${progresso.total}` : ''}
        </div>
      )}
      {status === 'erro' && <div className="status-arquivo erro">✖ Erro ao processar — confira o arquivo</div>}
      {status === 'ok' && relatorio && (
        <>
          <div className="status-arquivo ok">✔ Processado com sucesso</div>
          <div className="resumo-arquivo">
            {relatorio.itens.length} item(ns) · {fmtMoeda(valorTotal)}
            {relatorio.avisos.length > 0 && ` · ${relatorio.avisos.length} para conferência`}
          </div>
        </>
      )}
    </div>
  );
}

export default function ImportarEstoque({ onSnapshotGerado }) {
  const [arquivos, setArquivos] = useState({});
  const [status, setStatus] = useState({});
  const [progresso, setProgresso] = useState({});
  const [resultados, setResultados] = useState({});
  const [analiseGerada, setAnaliseGerada] = useState(null);
  const [erroGeral, setErroGeral] = useState(null);
  // Último relatório já importado de cada tipo (null enquanto carrega) — é o
  // que vale pra qualquer tipo que não for enviado agora.
  const [anteriores, setAnteriores] = useState(null);

  useEffect(() => {
    let ativo = true;
    buscarRelatoriosAnteriores()
      .then((r) => { if (ativo) setAnteriores(r); })
      .catch(() => { if (ativo) setAnteriores({ positivo: null, negativo: null, zerado: null }); });
    return () => { ativo = false; };
  }, []);

  async function handleArquivo(chave, file) {
    setArquivos((s) => ({ ...s, [chave]: file }));
    setStatus((s) => ({ ...s, [chave]: 'processando' }));
    setResultados((r) => ({ ...r, [chave]: null }));
    setAnaliseGerada(null);
    setErroGeral(null);
    geradoRef.current = false;
    try {
      const texto = await extrairTextoPdf(file, (atual, total) =>
        setProgresso((p) => ({ ...p, [chave]: { atual, total } }))
      );
      const relatorio = parseRelatorioEstoque(texto, chave);
      setResultados((r) => ({ ...r, [chave]: relatorio }));
      setStatus((s) => ({ ...s, [chave]: 'ok' }));
    } catch (e) {
      console.error(e);
      setStatus((s) => ({ ...s, [chave]: 'erro' }));
    }
  }

  const todosProcessados = TIPOS.every((t) => status[t.chave] === 'ok');
  const totalAvisos = Object.values(resultados).reduce((s, r) => s + (r?.avisos?.length ?? 0), 0);
  // Regra: tipo de relatório não enviado agora mantém o último já importado.
  // O negativo pode nunca ter existido (sem itens negativos) e tudo bem; já
  // positivo e zerado sem nenhuma importação anterior não dá pra completar.
  const algumProcessando = TIPOS.some((t) => status[t.chave] === 'processando');
  const algumEnviado = TIPOS.some((t) => status[t.chave] === 'ok');
  const faltantes = TIPOS.filter((t) => status[t.chave] !== 'ok');
  const faltamSemAnterior = faltantes.filter((t) => t.chave !== 'negativo' && !anteriores?.[t.chave]);
  const mostrarCompletarComAnteriores = !todosProcessados && algumEnviado && !algumProcessando;
  const podeCompletarComAnteriores = mostrarCompletarComAnteriores && anteriores !== null && faltamSemAnterior.length === 0;

  // Sem cleanup de propósito: o avanço pra aba de Alertas é um setTimeout, e
  // a própria geração muda `analiseGerada` (dependência do efeito) — um
  // cleanup cancelaria esse timer antes de disparar e o app seguiria
  // mostrando o snapshot antigo. A trava por ref evita gerar duas vezes.
  const geradoRef = useRef(false);
  const gerarAnalise = useCallback(() => {
    if (geradoRef.current) return;
    geradoRef.current = true;
    try {
      const herdados = {};
      for (const t of TIPOS) {
        if (status[t.chave] !== 'ok' && anteriores?.[t.chave]) herdados[t.chave] = anteriores[t.chave];
      }
      const snapshot = unificarSnapshot({
        positivo: resultados.positivo,
        negativo: resultados.negativo,
        zerado: resultados.zerado,
        herdados,
      });
      const registro = salvarSnapshot(snapshot);
      setAnaliseGerada(registro);
      setTimeout(() => onSnapshotGerado(registro), 1100);
    } catch (e) {
      geradoRef.current = false;
      console.error(e);
      setErroGeral('Não foi possível gerar a análise. Confira os PDFs importados.');
    }
  }, [resultados, status, anteriores, onSnapshotGerado]);

  // Com os 3 relatórios processados a análise sai sozinha, sem clique.
  useEffect(() => {
    if (todosProcessados && !analiseGerada) gerarAnalise();
  }, [todosProcessados, analiseGerada, gerarAnalise]);

  return (
    <div>
      <h2>Importar estoque atual</h2>
      <p className="subtitulo-pagina">
        Importe os três relatórios do sistema Net Use (positivo, negativo e zerado). Cada importação gera um novo
        snapshot com data e hora, comparável ao anterior. Se algum relatório não for enviado, o sistema mantém o
        último já importado daquele tipo (e avisa de qual data).
      </p>

      <div className="dropzone-grid">
        {TIPOS.map((tipo) => (
          <Dropzone
            key={tipo.chave}
            tipo={tipo}
            arquivo={arquivos[tipo.chave]}
            status={status[tipo.chave]}
            progresso={progresso[tipo.chave]}
            relatorio={resultados[tipo.chave]}
            onArquivo={handleArquivo}
          />
        ))}
      </div>

      {totalAvisos > 0 && (
        <div className="card" style={{ background: 'var(--amarelo-claro)', borderColor: '#FDE68A' }}>
          <h3 style={{ color: 'var(--amarelo)' }}>⚠️ {totalAvisos} linha(s) para conferência</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            Nessas linhas o total impresso no relatório não bate exatamente com preço × quantidade — pode ser
            arredondamento do sistema de origem, mas vale conferir antes de confiar 100% nesses itens específicos.
          </p>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--azul)' }}>Ver linhas para conferência</summary>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Código</th><th>Descrição</th><th>Motivo</th></tr></thead>
              <tbody>
                {Object.entries(resultados).flatMap(([chave, r]) =>
                  (r?.avisos ?? []).map((a, i) => (
                    <tr key={`${chave}-${i}`}>
                      <td>{a.codigo}</td>
                      <td>{a.descricao}</td>
                      <td>{a.motivo}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </details>
        </div>
      )}

      {erroGeral && <div className="status-arquivo erro" style={{ marginBottom: 10 }}>{erroGeral}</div>}

      {analiseGerada && (
        <div className="status-arquivo ok" style={{ marginBottom: 10 }}>
          ✔ Análise gerada — {analiseGerada.resumo.totalItens} itens processados. Abrindo Alertas de Compra…
        </div>
      )}
      {!analiseGerada && todosProcessados && !erroGeral && (
        <div className="status-arquivo pendente" style={{ marginBottom: 10 }}>Gerando análise…</div>
      )}
      {!analiseGerada && mostrarCompletarComAnteriores && !erroGeral && (
        <div className="status-arquivo pendente" style={{ marginBottom: 10 }}>
          {anteriores === null && 'Verificando importações anteriores…'}
          {anteriores !== null && faltantes.map((t) => {
            const anterior = anteriores[t.chave];
            return (
              <div key={t.chave}>
                <strong>{t.titulo}</strong> não enviado:{' '}
                {anterior
                  ? `será mantido o relatório de ${new Date(anterior.data).toLocaleDateString('pt-BR')} (${anterior.itens.length} itens), exceto produtos que aparecerem nos relatórios novos.`
                  : t.chave === 'negativo'
                    ? 'nunca foi importado — nenhum item será marcado como negativo.'
                    : 'ainda não há importação anterior; envie este relatório.'}
              </div>
            );
          })}
          {anteriores !== null && (
            <button className="btn" disabled={!podeCompletarComAnteriores} onClick={gerarAnalise} style={{ marginTop: 8 }}>
              Gerar análise mantendo os relatórios anteriores
            </button>
          )}
        </div>
      )}
    </div>
  );
}
