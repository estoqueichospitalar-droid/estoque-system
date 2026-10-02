import { getUltimoSnapshot, getSnapshotAnterior } from '../lib/historicoPedidos';
import { gerarPainelAlertas } from '../lib/alertas';
import { listarResumosMeses } from '../lib/historicoVendas';
import AnaliseIA from './AnaliseIA';
import GraficoFaturamentoEstoque from './GraficoFaturamentoEstoque';
import EscoamentoEstoque from './EscoamentoEstoque';

function fmtMoeda(v) {
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Dashboard({ snapshot }) {
  const atual = snapshot ?? getUltimoSnapshot();
  const anterior = getSnapshotAnterior();

  if (!atual) {
    return (
      <div className="vazio">
        Nenhuma análise gerada ainda. Vá para a aba <strong>Importar</strong> e envie os três relatórios de estoque.
      </div>
    );
  }

  const { resumo } = atual;
  const diffValor = anterior ? resumo.valorTotalEstoque - anterior.resumo.valorTotalEstoque : null;

  return (
    <div>
      <h2>Visão geral do estoque</h2>
      <p className="subtitulo-pagina">
        Snapshot gerado em {new Date(atual.criadoEm).toLocaleString('pt-BR')}
        {anterior && ` · comparado ao snapshot de ${new Date(anterior.criadoEm).toLocaleString('pt-BR')}`}
      </p>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-num">{resumo.totalItens}</div>
          <div className="kpi-lbl">Itens no estoque</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-num">{fmtMoeda(resumo.valorTotalEstoque)}</div>
          <div className="kpi-lbl">Valor total (custo)</div>
          {diffValor !== null && (
            <div style={{ fontSize: 11, color: diffValor >= 0 ? 'var(--verde)' : 'var(--vermelho)', marginTop: 3 }}>
              {diffValor >= 0 ? '+' : ''}{fmtMoeda(diffValor)} vs. anterior
            </div>
          )}
        </div>
        <div className="kpi-card">
          <div className="kpi-num" style={{ color: 'var(--verde)' }}>{resumo.itensPositivos}</div>
          <div className="kpi-lbl">Itens com estoque positivo</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-num" style={{ color: 'var(--roxo)' }}>{resumo.itensZerados}</div>
          <div className="kpi-lbl">Itens zerados</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-num" style={{ color: 'var(--vermelho)' }}>{resumo.itensNegativos}</div>
          <div className="kpi-lbl">Itens com estoque negativo</div>
        </div>
      </div>

      <GraficoFaturamentoEstoque meses={listarResumosMeses()}valorTotalEstoque={resumo.valorTotalEstoque} />

      <EscoamentoEstoque itensEstoque={atual.itens} />

      <div className="card card-blue" style={{ background: 'var(--azul-claro)' }}>
        <h3>📌 Próximo passo</h3>
        <p style={{ fontSize: 12.5 }}>
          Veja a aba <strong>Alertas de Compra</strong> para a lista priorizada de produtos que precisam de atenção,
          e a aba <strong>Ordem de Compra</strong> para montar e exportar o pedido em PDF segmentado por fornecedor.
        </p>
      </div>

      <AnaliseIA painel={gerarPainelAlertas(atual.itens)} />
    </div>
  );
}
