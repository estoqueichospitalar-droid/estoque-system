// Guarda cada mês de vendas importado, indexado pela chave do mês
// ("2026-06"). Reimportar o mesmo mês SOBRESCREVE (o chamador deve
// confirmar com o usuário antes — ver ImportarVendas.jsx), nunca duplica.

import { pushVendasMes, pushRemoverVendasMes } from './sync/push';
import { salvarLocalComFallback } from './storageSeguro';

export const CHAVE_VENDAS_MENSAIS = 'ic_supra_vendas_mensais_v1';
const CHAVE = CHAVE_VENDAS_MENSAIS;

// Cada mês guarda o item a item de todo o catálogo vendido — sem limite,
// isso cresce pra sempre e, junto com o snapshot de estoque (~10 mil
// itens), estoura a cota do navegador (visto na prática). Só os meses mais
// recentes ficam em cache local; o histórico completo (todo mês já
// importado) é preservado no Supabase, puxado de volta quando precisar —
// ver src/lib/sync/pull.js. "Todos os meses importados" nos filtros da UI
// reflete o que está em cache local, não necessariamente o histórico
// inteiro desde sempre.
export const MAX_MESES_LOCAIS = 6;

// Índice separado, leve e NUNCA podado: só os códigos que já venderam
// alguma vez, sem descrição/valores/quantidade — pra 10 mil produtos isso
// não passa de algumas centenas de KB, nada comparado ao detalhe item a
// item por mês. Existe porque, quando um mês antigo sai do cache local
// (acima), a informação "esse código já vendeu" não pode ir junto — senão
// um produto que só vendeu há 7 meses passaria a parecer "sem giro desde
// sempre" só por causa do limite de cache, quando na verdade só está fora
// da janela recente. Isso alimenta a proteção contra "marcar como
// descontinuado" e a opção "Todos os meses importados" em Valor para
// Escoamento — ver EscoamentoEstoque.jsx e alertas.js.
const CHAVE_CODIGOS_VENDA_HISTORICA = 'ic_supra_codigos_venda_historica_v1';

// Índice leve de TODOS os meses já importados (só cabeçalho + resumo, sem os
// itens) — um registro por mês, poucos bytes. Existe porque o gráfico de
// faturamento precisa mostrar todo o histórico, mas o detalhe item a item só
// cabe em cache pros MAX_MESES_LOCAIS mais recentes. Alimentado pelo pull do
// Supabase (todos os meses do servidor) e por cada importação local.
export const CHAVE_RESUMOS_VENDAS = 'ic_supra_resumos_vendas_v1';

function lerResumos() {
  try {
    const raw = localStorage.getItem(CHAVE_RESUMOS_VENDAS);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function cabecalhoDe(registro) {
  return {
    mesChave: registro.mesChave,
    mesLabel: registro.mesLabel,
    periodoInicio: registro.periodoInicio ?? null,
    periodoFim: registro.periodoFim ?? null,
    resumo: registro.resumo ?? {},
    importadoEm: registro.importadoEm,
  };
}

/** Substitui o índice inteiro (usado pelo pull, que enxerga todos os meses do servidor). */
export function substituirResumosMeses(registros) {
  const indice = {};
  for (const r of registros) indice[r.mesChave] = cabecalhoDe(r);
  salvarLocalComFallback(CHAVE_RESUMOS_VENDAS, indice);
}

/**
 * Todos os meses conhecidos (índice leve + o que está no cache detalhado, que
 * prevalece por ser mais recente quando divergem), do mais antigo ao mais
 * novo. Não traz os itens — serve ao gráfico de faturamento.
 */
export function listarResumosMeses() {
  const indice = lerResumos();
  for (const mes of Object.values(ler())) indice[mes.mesChave] = cabecalhoDe(mes);
  return Object.values(indice)
    .filter((m) => m.mesChave && m.resumo)
    .sort((a, b) => (a.mesChave < b.mesChave ? -1 : 1));
}

/** Mantém só os N meses mais recentes (por mesChave) — usado aqui e em src/lib/sync/pull.js. */
export function podarParaLimiteLocal(obj) {
  const chaves = Object.keys(obj).sort();
  const recentes = chaves.slice(-MAX_MESES_LOCAIS);
  const podado = {};
  for (const k of recentes) podado[k] = obj[k];
  return podado;
}

function ler() {
  try {
    const raw = localStorage.getItem(CHAVE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function salvar(obj) {
  salvarLocalComFallback(CHAVE, podarParaLimiteLocal(obj));
}

/** Acrescenta códigos ao índice histórico (nunca remove) — chamado a cada mês importado ou puxado do Supabase. */
export function registrarCodigosNoIndiceHistorico(codigos) {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(CHAVE_CODIGOS_VENDA_HISTORICA) || '[]');
  } catch {
    raw = [];
  }
  const conjunto = new Set(raw);
  for (const c of codigos) conjunto.add(c);
  salvarLocalComFallback(CHAVE_CODIGOS_VENDA_HISTORICA, Array.from(conjunto));
}

/** Todos os códigos que já venderam alguma vez, mesmo em meses que já saíram do cache local detalhado. */
export function getTodosCodigosComVendaHistorica() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAVE_CODIGOS_VENDA_HISTORICA) || '[]');
    return new Set(raw);
  } catch {
    return new Set();
  }
}

export function getTodasVendas() {
  return ler();
}

export function getVendasMes(mesChave) {
  return ler()[mesChave] ?? null;
}

export function mesJaImportado(mesChave) {
  const todos = ler();
  return Object.prototype.hasOwnProperty.call(todos, mesChave);
}

/**
 * Salva/sobrescreve um mês de vendas. Devolve o registro salvo.
 */
export function salvarVendasMes(relatorioParsed, nomeArquivo) {
  const todos = ler();
  const chave = relatorioParsed.mesChave ?? `desconhecido-${Date.now()}`;
  const registro = {
    mesChave: chave,
    mesLabel: relatorioParsed.mesLabel,
    periodoInicio: relatorioParsed.periodoInicio,
    periodoFim: relatorioParsed.periodoFim,
    itens: relatorioParsed.itens,
    resumo: relatorioParsed.resumo,
    nomeArquivo,
    importadoEm: new Date().toISOString(),
  };
  todos[chave] = registro;
  // Push antes do salvamento local: se o localStorage estiver cheio e
  // lançar (ou o podado remover esse mês da lista local), o envio pro
  // Supabase já foi disparado mesmo assim — o histórico completo lá nunca
  // é podado.
  pushVendasMes(registro);
  salvar(todos);
  registrarCodigosNoIndiceHistorico(relatorioParsed.itens.map((i) => i.codigo));
  const indice = lerResumos();
  indice[chave] = cabecalhoDe(registro);
  salvarLocalComFallback(CHAVE_RESUMOS_VENDAS, indice);
  return registro;
}

export function removerVendasMes(mesChave) {
  const todos = ler();
  delete todos[mesChave];
  pushRemoverVendasMes(mesChave);
  salvar(todos);
  const indice = lerResumos();
  delete indice[mesChave];
  salvarLocalComFallback(CHAVE_RESUMOS_VENDAS, indice);
}

/**
 * Lista os meses importados, ordenados cronologicamente (mais antigo primeiro).
 */
export function listarMesesImportados() {
  const todos = ler();
  return Object.values(todos).sort((a, b) => (a.mesChave < b.mesChave ? -1 : 1));
}

/**
 * Soma volume e faturamento por código de produto, considerando TODOS os
 * meses de vendas importados (Mix de Vendas). É a fonte única usada tanto
 * para decidir se um produto tem "venda recente registrada" (proteção contra
 * descontinuação — ver alertas.js) quanto para mostrar faturamento/volume na
 * aba Alertas de Compra.
 *
 * Um código aparecer aqui (mesmo com valores baixos) significa que ele
 * vendeu em algum mês importado — meses sem venda de um produto simplesmente
 * não o listam, então presença no mapa = venda real registrada.
 */
export function getResumoVendasPorProduto() {
  const meses = listarMesesImportados();
  const resumo = {};
  for (const mes of meses) {
    for (const item of mes.itens) {
      const atual = resumo[item.codigo] ?? { qtdeVolumes: 0, totVendas: 0 };
      atual.qtdeVolumes += item.qtdeVolumes;
      atual.totVendas += item.totVendas;
      resumo[item.codigo] = atual;
    }
  }
  return resumo;
}

/**
 * Conjunto de códigos com pelo menos uma venda registrada, em algum mês já
 * importado — inclui tanto os meses ainda com detalhe completo em cache
 * local quanto os mais antigos que só sobrevivem no índice leve (ver
 * CHAVE_CODIGOS_VENDA_HISTORICA acima). Usado para proteger produtos de
 * qualquer marcação de "descontinuado" — zerado no estoque significa
 * "precisa comprar", nunca "descontinuar", quando o item vende.
 */
export function getCodigosComVendaRegistrada() {
  const doCache = Object.keys(getResumoVendasPorProduto());
  const doIndice = getTodosCodigosComVendaHistorica();
  return new Set([...doCache, ...doIndice]);
}
