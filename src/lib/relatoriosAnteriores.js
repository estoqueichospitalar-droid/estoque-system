// Regra de "manter o relatório que não tem importação recente": quando uma
// importação de estoque não traz um dos três relatórios (positivo, negativo,
// zerado), o último já importado daquele tipo continua valendo — senão o
// tipo ausente simplesmente sumiria do snapshot (ex: sem o relatório de
// negativos, todo item negativo desaparecia da lista de alertas).

import { supabase, isSupabaseConfigured, buscarTodasLinhas } from './supabaseClient';
import { getUltimoSnapshot } from './historicoPedidos';

const COLUNA_CONTAGEM = {
  positivo: 'itens_positivos',
  negativo: 'itens_negativos',
  zerado: 'itens_zerados',
};

function dataDaFonte(snapshot, origem) {
  return snapshot.fontes?.[origem]?.data ?? snapshot.criadoEm;
}

/**
 * Último relatório do tipo `origem` ({ itens, data }) ou null se nunca houve.
 * Olha primeiro o snapshot atual do navegador; se ele não tem itens desse
 * tipo, procura o snapshot mais recente do servidor que tenha.
 */
export async function buscarRelatorioAnterior(origem) {
  const local = getUltimoSnapshot();
  if (local) {
    const itens = local.itens.filter((i) => i.origem === origem);
    if (itens.length > 0) return { itens, data: dataDaFonte(local, origem) };
  }
  if (!isSupabaseConfigured()) return null;

  try {
    const { data: snaps, error } = await supabase
      .from('snapshots_estoque')
      .select('*')
      .gt(COLUNA_CONTAGEM[origem], 0)
      .order('criado_em', { ascending: false })
      .limit(1);
    if (error) throw error;
    const snap = snaps?.[0];
    if (!snap) return null;

    const linhas = await buscarTodasLinhas(() => supabase
      .from('itens_estoque')
      .select('*')
      .eq('snapshot_id', snap.id)
      .eq('origem', origem)
      .order('id'));
    if (linhas.length === 0) return null;
    return {
      itens: linhas.map((it) => ({
        codigo: it.codigo,
        codigoBarras: it.codigo_barras,
        descricao: it.descricao,
        unidade: it.unidade,
        precoCusto: Number(it.preco_custo),
        quantidade: Number(it.quantidade),
        total: Number(it.total),
        origem: it.origem,
        confianca: it.confianca,
      })),
      data: snap.fontes?.[origem]?.data ?? snap.criado_em,
    };
  } catch (e) {
    console.warn(`[estoque] Não foi possível buscar o último relatório ${origem} no servidor.`, e);
    return null;
  }
}

/** { positivo, negativo, zerado } com o último relatório de cada tipo (null onde nunca houve). */
export async function buscarRelatoriosAnteriores() {
  const [positivo, negativo, zerado] = await Promise.all([
    buscarRelatorioAnterior('positivo'),
    buscarRelatorioAnterior('negativo'),
    buscarRelatorioAnterior('zerado'),
  ]);
  return { positivo, negativo, zerado };
}
