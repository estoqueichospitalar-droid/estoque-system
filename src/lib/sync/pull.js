// Puxa tudo do Supabase pro localStorage, uma vez, no início da sessão (ver
// App.jsx). NUNCA sobrescreve o blob inteiro com a versão do servidor — faz
// merge registro a registro comparando `atualizadoEm`, porque uma escrita
// local pode ter acontecido antes deste pull terminar (ver comentário sobre
// a corrida em App.jsx). Nunca lança: uma falha aqui deixa o app seguir
// com o que já tinha no localStorage.

import { supabase, isSupabaseConfigured, buscarTodasLinhas } from '../supabaseClient';
import { pushVendasMes, pushFornecedorUpsert, pushVinculoUpsert } from './push';
import { CHAVE_CONFIG_PRODUTOS } from '../configProdutos';
import { CHAVE_SNAPSHOTS, CHAVE_PEDIDOS } from '../historicoPedidos';
import {
  CHAVE_VENDAS_MENSAIS, MAX_MESES_LOCAIS, podarParaLimiteLocal, registrarCodigosNoIndiceHistorico, substituirResumosMeses,
} from '../historicoVendas';
import { CHAVE_FORNECEDORES, CHAVE_VINCULOS } from '../fornecedores';
import { salvarLocalComFallback } from '../storageSeguro';

// Só o snapshot mais recente fica em cache local (mesmo limite de
// src/lib/historicoPedidos.js) — puxar o histórico inteiro de volta do
// Supabase a cada login é a forma mais fácil de estourar a cota do
// navegador logo na abertura da sessão.
const MAX_SNAPSHOTS_LOCAIS = 1;

function lerLocal(chave, padrao) {
  try {
    const raw = localStorage.getItem(chave);
    return raw ? JSON.parse(raw) : padrao;
  } catch {
    return padrao;
  }
}

function salvarLocal(chave, valor) {
  salvarLocalComFallback(chave, valor);
}

async function puxarConfigProdutos() {
  const data = await buscarTodasLinhas(() => supabase.from('config_produtos').select('*').order('codigo'));

  const local = lerLocal(CHAVE_CONFIG_PRODUTOS, {});
  for (const row of data) {
    const remoto = {
      estoqueMinimo: row.estoque_minimo,
      estoqueMinimoOrigem: row.estoque_minimo_origem,
      giroSemanal: row.giro_semanal,
      giroOrigem: row.giro_origem,
      leadTimeDias: row.lead_time_dias,
      margemSegurancaDias: row.margem_seguranca_dias,
      fornecedor: row.fornecedor,
      setor: row.setor,
      descontinuado: row.descontinuado,
      atualizadoEm: row.atualizado_em,
    };
    const existente = local[row.codigo];
    if (!existente || new Date(remoto.atualizadoEm) > new Date(existente.atualizadoEm ?? 0)) {
      local[row.codigo] = remoto;
    }
  }
  salvarLocal(CHAVE_CONFIG_PRODUTOS, local);
}

async function puxarSnapshots() {
  const { data: snaps, error } = await supabase
    .from('snapshots_estoque')
    .select('*')
    .order('criado_em', { ascending: false })
    .limit(MAX_SNAPSHOTS_LOCAIS);
  if (error) throw error;
  if (!snaps || snaps.length === 0) return;

  const ids = snaps.map((s) => s.id);
  const itens = await buscarTodasLinhas(() => supabase
    .from('itens_estoque')
    .select('*')
    .in('snapshot_id', ids)
    .order('id'));

  const itensPorSnapshot = new Map();
  for (const it of itens) {
    if (!itensPorSnapshot.has(it.snapshot_id)) itensPorSnapshot.set(it.snapshot_id, []);
    itensPorSnapshot.get(it.snapshot_id).push({
      codigo: it.codigo,
      codigoBarras: it.codigo_barras,
      descricao: it.descricao,
      unidade: it.unidade,
      precoCusto: Number(it.preco_custo),
      quantidade: Number(it.quantidade),
      total: Number(it.total),
      origem: it.origem,
      confianca: it.confianca,
    });
  }

  const remotos = snaps.map((s) => ({
    id: s.id,
    criadoEm: s.criado_em,
    resumo: {
      totalItens: s.total_itens,
      valorTotalEstoque: Number(s.valor_total_estoque),
      itensNegativos: s.itens_negativos,
      itensZerados: s.itens_zerados,
      itensPositivos: s.itens_positivos,
    },
    itens: itensPorSnapshot.get(s.id) ?? [],
    avisos: [],
  }));

  const local = lerLocal(CHAVE_SNAPSHOTS, []);
  const porId = new Map(local.map((s) => [s.id, s]));
  // snapshot é imutável depois de criado — a versão do servidor sempre pode
  // prevalecer com segurança quando o id já existe dos dois lados.
  for (const r of remotos) porId.set(r.id, r);
  const unidos = Array.from(porId.values()).sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  salvarLocal(CHAVE_SNAPSHOTS, unidos.slice(0, MAX_SNAPSHOTS_LOCAIS));
}

async function puxarPedidos() {
  const pedidos = await buscarTodasLinhas(() => supabase.from('pedidos_compra').select('*').order('id'));
  if (pedidos.length === 0) return;

  const ids = pedidos.map((p) => p.id);
  // `.in()` com centenas de ids estoura o tamanho da URL — busca em lotes.
  const itens = [];
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100);
    itens.push(...await buscarTodasLinhas(() => supabase
      .from('itens_pedido_compra')
      .select('*')
      .in('pedido_id', lote)
      .order('id')));
  }

  const itensPorPedido = new Map();
  for (const it of itens) {
    if (!itensPorPedido.has(it.pedido_id)) itensPorPedido.set(it.pedido_id, []);
    itensPorPedido.get(it.pedido_id).push({
      codigo: it.codigo,
      descricao: it.descricao,
      unidade: it.unidade,
      qtdPedida: Number(it.qtd_pedida),
      qtdRecebida: Number(it.qtd_recebida),
      custoUnit: Number(it.custo_unit),
    });
  }

  const local = lerLocal(CHAVE_PEDIDOS, []);
  const porId = new Map(local.map((p) => [p.id, p]));
  for (const p of pedidos) {
    const remoto = {
      id: p.id,
      criadoEm: p.criado_em,
      atualizadoEm: p.atualizado_em,
      fornecedor: p.fornecedor,
      status: p.status,
      observacoes: p.observacoes,
      motivoCancelamento: p.motivo_cancelamento,
      itens: itensPorPedido.get(p.id) ?? [],
    };
    const existente = porId.get(p.id);
    if (!existente || new Date(remoto.atualizadoEm) > new Date(existente.atualizadoEm ?? existente.criadoEm ?? 0)) {
      porId.set(p.id, remoto);
    }
  }
  const unidos = Array.from(porId.values()).sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
  salvarLocal(CHAVE_PEDIDOS, unidos);
}

async function puxarVendas() {
  // Cabeçalhos de TODOS os meses do servidor (uma linha por mês, leve) — é o
  // que alimenta o gráfico de faturamento, que mostra o histórico inteiro
  // independente de quantos meses cabem no cache detalhado.
  const cabecalhosRemotos = await buscarTodasLinhas(() => supabase
    .from('vendas_mensais')
    .select('mes_chave, mes_label, periodo_inicio, periodo_fim, resumo, nome_arquivo, importado_em')
    .order('mes_chave'));
  const remotoPorChave = new Map(cabecalhosRemotos.map((c) => [c.mes_chave, c]));
  const local = lerLocal(CHAVE_VENDAS_MENSAIS, {});

  // Meses que só existem neste navegador (importados antes da sincronização
  // existir, ou cuja gravação no servidor falhou) ou que aqui são mais novos:
  // sobem agora. Sem isso, cada usuário só enxerga o que ele mesmo importou
  // ou o que por acaso já estava no servidor.
  const pendentes = Object.values(local).filter((m) => {
    if (!m?.mesChave || !m.itens?.length) return false;
    const r = remotoPorChave.get(m.mesChave);
    return !r || new Date(m.importadoEm).getTime() > new Date(r.importado_em).getTime();
  });
  for (const m of pendentes) await pushVendasMes(m);

  const indice = new Map(cabecalhosRemotos.map((c) => [c.mes_chave, {
    mesChave: c.mes_chave,
    mesLabel: c.mes_label,
    periodoInicio: c.periodo_inicio,
    periodoFim: c.periodo_fim,
    resumo: c.resumo,
    importadoEm: c.importado_em,
  }]));
  for (const m of pendentes) indice.set(m.mesChave, m);
  substituirResumosMeses(Array.from(indice.values()));

  // Item a item só dos meses mais recentes (limite do cache local).
  const chaves = Array.from(indice.keys()).sort().slice(-MAX_MESES_LOCAIS);
  for (const chave of chaves) {
    const cab = indice.get(chave);
    const existente = local[chave];
    const esperado = cab.resumo?.produtosVendidos;
    const completo = existente
      && new Date(existente.importadoEm).getTime() === new Date(cab.importadoEm).getTime()
      && (esperado == null || existente.itens?.length === esperado);
    if (completo) continue;

    const linhas = await buscarTodasLinhas(() => supabase
      .from('itens_venda_mensal')
      .select('*')
      .eq('mes_chave', chave)
      .order('id'));
    // O servidor tem o cabeçalho do mês mas só parte dos itens (envio
    // interrompido), e este navegador tem o mês completo: reenvia em vez de
    // sobrescrever o cache bom com o incompleto.
    if (esperado != null && linhas.length < esperado && existente?.itens?.length === esperado) {
      await pushVendasMes(existente);
      continue;
    }
    const itens = linhas.map((it) => ({
      codigo: it.codigo,
      codigoBarras: it.codigo_barras,
      descricao: it.descricao,
      unidade: it.unidade,
      qtdeNotas: Number(it.qtde_notas),
      qtdeVolumes: Number(it.qtde_volumes),
      totComissoes: Number(it.tot_comissoes),
      totVendas: Number(it.tot_vendas),
    }));
    const remoto = {
      mesChave: chave,
      mesLabel: cab.mesLabel,
      periodoInicio: cab.periodoInicio,
      periodoFim: cab.periodoFim,
      resumo: cab.resumo,
      nomeArquivo: remotoPorChave.get(chave)?.nome_arquivo ?? null,
      importadoEm: cab.importadoEm,
      itens,
    };
    if (!existente || new Date(remoto.importadoEm).getTime() >= new Date(existente.importadoEm ?? 0).getTime()) {
      local[chave] = remoto;
    }
  }
  salvarLocal(CHAVE_VENDAS_MENSAIS, podarParaLimiteLocal(local));
}

/**
 * Só os códigos (sem descrição/valores) de TODO o histórico de vendas já
 * importado, não só os meses recentes cacheados acima — alimenta o índice
 * leve que nunca é podado (ver registrarCodigosNoIndiceHistorico em
 * historicoVendas.js), pra um produto que vendeu há muitos meses não virar
 * falso positivo de "sem giro"/"descontinuar" só por causa do cache local
 * limitado. Paginado porque isso pode passar de mil linhas com vários meses
 * de histórico — o limite padrão do PostgREST é 1000 por chamada.
 */
async function puxarIndiceCodigosVenda() {
  const linhas = await buscarTodasLinhas(() => supabase.from('itens_venda_mensal').select('codigo').order('id'));
  const codigos = new Set(linhas.map((row) => row.codigo));
  if (codigos.size > 0) registrarCodigosNoIndiceHistorico(codigos);
}

function normalizarNome(nome) {
  return String(nome ?? '').trim().toLowerCase();
}

/**
 * Fornecedores e vínculos produto↔fornecedor andam juntos porque o vínculo
 * aponta pro id do fornecedor. Cada navegador cadastra a lista padrão de
 * fornecedores por conta própria (ids aleatórios diferentes) quando o envio
 * ao servidor falha ou ainda não existia — então, ao sincronizar:
 *  - cópia local sem equivalente por id, mas com o MESMO NOME de um
 *    fornecedor do servidor, é descartada e seus vínculos passam pro id do
 *    servidor (senão cada usuário veria a lista duplicada);
 *  - cópia local que o servidor não conhece de jeito nenhum é enviada.
 */
async function puxarFornecedoresEVinculos() {
  const linhasF = await buscarTodasLinhas(() => supabase.from('fornecedores').select('*').order('id'));
  const linhasV = await buscarTodasLinhas(() => supabase.from('produto_fornecedor').select('*').order('id'));

  const idsRemotosF = new Set(linhasF.map((r) => r.id));
  const idPorNomeRemoto = new Map();
  for (const r of linhasF) {
    const chave = normalizarNome(r.nome);
    if (!idPorNomeRemoto.has(chave)) idPorNomeRemoto.set(chave, r.id);
  }

  const alias = new Map(); // id local descartado -> id do servidor
  const fornecedoresPendentes = [];
  const locaisMantidos = [];
  for (const f of lerLocal(CHAVE_FORNECEDORES, [])) {
    if (idsRemotosF.has(f.id)) { locaisMantidos.push(f); continue; }
    const idDoServidor = idPorNomeRemoto.get(normalizarNome(f.nome));
    if (idDoServidor) { alias.set(f.id, idDoServidor); continue; }
    locaisMantidos.push(f);
    fornecedoresPendentes.push(f);
  }
  mesclarFornecedores(linhasF, locaisMantidos);

  const idsRemotosV = new Set(linhasV.map((r) => r.id));
  const parRemoto = new Set(linhasV.map((r) => `${r.codigo}|${r.fornecedor_id}`));
  const vinculosPendentes = [];
  const vinculosMantidos = [];
  const paresVistos = new Set();
  for (const v0 of lerLocal(CHAVE_VINCULOS, [])) {
    const v = alias.has(v0.fornecedorId) ? { ...v0, fornecedorId: alias.get(v0.fornecedorId) } : v0;
    if (idsRemotosV.has(v.id)) { vinculosMantidos.push(v); continue; }
    const par = `${v.codigo}|${v.fornecedorId}`;
    if (parRemoto.has(par) || paresVistos.has(par)) continue; // o servidor (ou outra cópia local) já tem esse par
    paresVistos.add(par);
    vinculosMantidos.push(v);
    vinculosPendentes.push(v);
  }
  mesclarVinculos(linhasV, vinculosMantidos);

  // Sequencial e fornecedores antes dos vínculos (chave estrangeira).
  for (const f of fornecedoresPendentes) await pushFornecedorUpsert(f);
  for (const v of vinculosPendentes) await pushVinculoUpsert(v);
}

function mesclarFornecedores(data, local) {
  const porId = new Map(local.map((f) => [f.id, f]));
  for (const row of data) {
    const remoto = {
      id: row.id,
      nome: row.nome,
      email: row.email,
      telefone: row.telefone,
      envioAutomatico: row.envio_automatico,
      ativo: row.ativo,
      prazoPagamentoDias: row.prazo_pagamento_dias,
      modalidadeFrete: row.modalidade_frete,
      freteLimiar: row.frete_limiar != null ? Number(row.frete_limiar) : null,
      limiteCredito: row.limite_credito != null ? Number(row.limite_credito) : null,
      especialidade: row.especialidade,
      setor: row.setor,
      criadoEm: row.criado_em,
      atualizadoEm: row.atualizado_em,
    };
    const existente = porId.get(row.id);
    if (!existente || new Date(remoto.atualizadoEm) > new Date(existente.atualizadoEm ?? 0)) {
      porId.set(row.id, remoto);
    }
  }
  salvarLocal(CHAVE_FORNECEDORES, Array.from(porId.values()));
}

function mesclarVinculos(data, local) {
  const porId = new Map(local.map((v) => [v.id, v]));
  for (const row of data) {
    const remoto = {
      id: row.id,
      codigo: row.codigo,
      fornecedorId: row.fornecedor_id,
      custoUnitario: row.custo_unitario != null ? Number(row.custo_unitario) : null,
      disponivel: row.disponivel,
      atualizadoEm: row.atualizado_em,
    };
    const existente = porId.get(row.id);
    if (!existente || new Date(remoto.atualizadoEm) > new Date(existente.atualizadoEm ?? 0)) {
      porId.set(row.id, remoto);
    }
  }
  salvarLocal(CHAVE_VINCULOS, Array.from(porId.values()));
}

/**
 * Roda uma vez no início da sessão (App.jsx). Não faz nada se o Supabase não
 * estiver configurado. Nunca lança — cada tabela é independente, uma falha
 * numa não impede as outras, e uma falha geral só significa que o app segue
 * com o que já tinha no localStorage.
 */
export async function pullTudoDoSupabase() {
  if (!isSupabaseConfigured()) return;
  const resultados = await Promise.allSettled([
    puxarConfigProdutos(),
    puxarSnapshots(),
    puxarPedidos(),
    puxarVendas(),
    puxarIndiceCodigosVenda(),
    puxarFornecedoresEVinculos(),
  ]);
  for (const r of resultados) {
    if (r.status === 'rejected') {
      console.warn('[sync] Falha ao puxar dados do Supabase — o app segue com o que já tinha localmente.', r.reason);
    }
  }
}
