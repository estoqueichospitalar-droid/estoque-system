import { pushSnapshot, pushPedidoUpsert } from './sync/push';
import { salvarLocalComFallback } from './storageSeguro';

export const CHAVE_SNAPSHOTS = 'ic_supra_snapshots_v1';
export const CHAVE_PEDIDOS = 'ic_supra_pedidos_v1';

// Só o snapshot mais recente fica no localStorage — cada um carrega o
// catálogo inteiro (~10 mil itens), então guardar mais de um aqui já é
// suficiente pra estourar a cota do navegador (visto na prática: 10 mil
// itens + vários meses de vendas ultrapassam os 5-10MB típicos por site).
// O histórico completo (todo snapshot já gerado) é preservado no Supabase,
// insert-only — ver src/lib/sync/push.js. A comparação "vs. snapshot
// anterior" no Dashboard usa o que sobrar puxado do Supabase, quando houver.
const MAX_SNAPSHOTS_LOCAIS = 1;

function ler(chave, padrao) {
  try {
    const raw = localStorage.getItem(chave);
    return raw ? JSON.parse(raw) : padrao;
  } catch {
    return padrao;
  }
}

function salvar(chave, valor) {
  salvarLocalComFallback(chave, valor);
}

// ---------- Snapshots de estoque ----------

export function salvarSnapshot(snapshot) {
  const lista = ler(CHAVE_SNAPSHOTS, []);
  const registro = {
    id: crypto.randomUUID(),
    criadoEm: new Date().toISOString(),
    resumo: snapshot.resumo,
    itens: snapshot.itens,
    avisos: snapshot.avisos,
  };
  lista.unshift(registro); // mais recente primeiro
  pushSnapshot(registro); // manda o snapshot inteiro pro Supabase antes de truncar localmente
  salvar(CHAVE_SNAPSHOTS, lista.slice(0, MAX_SNAPSHOTS_LOCAIS));
  return registro;
}

export function listarSnapshots() {
  return ler(CHAVE_SNAPSHOTS, []);
}

export function getUltimoSnapshot() {
  const lista = listarSnapshots();
  return lista[0] ?? null;
}

export function getSnapshotAnterior() {
  const lista = listarSnapshots();
  return lista[1] ?? null;
}

// ---------- Pedidos de compra ----------

/**
 * Estrutura de um pedido:
 * {
 *   id, criadoEm, fornecedor,
 *   status: 'pendente' | 'enviado' | 'parcial' | 'recebido' | 'cancelado',
 *   motivoCancelamento: string | null, // só preenchido quando status = 'cancelado'
 *   itens: [{ codigo, descricao, unidade, qtdPedida, qtdRecebida, custoUnit }]
 * }
 */

function recalcularStatus(pedido) {
  if (pedido.status === 'cancelado') return; // cancelado nunca volta sozinho
  const totalPedido = pedido.itens.reduce((s, i) => s + i.qtdPedida, 0);
  const totalRecebido = pedido.itens.reduce((s, i) => s + (i.qtdRecebida ?? 0), 0);
  // "enviado" (mandado ao fornecedor) só existe enquanto nada foi recebido —
  // o primeiro recebimento já move o pedido pra parcial/recebido.
  const semRecebimento = pedido.status === 'enviado' ? 'enviado' : 'pendente';
  pedido.status = totalRecebido === 0 ? semRecebimento : totalRecebido >= totalPedido ? 'recebido' : 'parcial';
}

export function criarPedido({ fornecedor, itens, observacoes }) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const agora = new Date().toISOString();
  const pedido = {
    id: crypto.randomUUID(),
    criadoEm: agora,
    atualizadoEm: agora,
    fornecedor,
    status: 'pendente',
    observacoes: observacoes || null,
    itens: itens.map((i) => ({ ...i, qtdRecebida: 0 })),
  };
  lista.unshift(pedido);
  salvar(CHAVE_PEDIDOS, lista);
  pushPedidoUpsert(pedido);
  return pedido;
}

export function listarPedidos() {
  return ler(CHAVE_PEDIDOS, []);
}

export function atualizarStatusPedido(id, status) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const idx = lista.findIndex((p) => p.id === id);
  if (idx >= 0) {
    lista[idx].status = status;
    lista[idx].atualizadoEm = new Date().toISOString();
    salvar(CHAVE_PEDIDOS, lista);
    pushPedidoUpsert(lista[idx]);
  }
  return lista[idx];
}

export function registrarRecebimento(id, codigo, qtdRecebidaAdicional) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const pedido = lista.find((p) => p.id === id);
  if (!pedido) return null;
  const item = pedido.itens.find((i) => i.codigo === codigo);
  if (item) {
    item.qtdRecebida = (item.qtdRecebida ?? 0) + qtdRecebidaAdicional;
  }
  recalcularStatus(pedido);
  pedido.atualizadoEm = new Date().toISOString();
  salvar(CHAVE_PEDIDOS, lista);
  pushPedidoUpsert(pedido);
  return pedido;
}

/** Marca que o pedido (PDF) foi mandado ao fornecedor. Só vale pra pendente; "voltar" desfaz. */
export function marcarPedidoEnviado(id, enviado = true) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const pedido = lista.find((p) => p.id === id);
  if (!pedido) return null;
  if (enviado && pedido.status !== 'pendente') return pedido;
  if (!enviado && pedido.status !== 'enviado') return pedido;
  pedido.status = enviado ? 'enviado' : 'pendente';
  pedido.atualizadoEm = new Date().toISOString();
  salvar(CHAVE_PEDIDOS, lista);
  pushPedidoUpsert(pedido);
  return pedido;
}

/** Dá como recebido tudo o que ainda falta em cada item do pedido (chegou completo). */
export function receberTudo(id) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const pedido = lista.find((p) => p.id === id);
  if (!pedido || pedido.status === 'cancelado') return null;
  for (const item of pedido.itens) item.qtdRecebida = item.qtdPedida;
  recalcularStatus(pedido);
  pedido.atualizadoEm = new Date().toISOString();
  salvar(CHAVE_PEDIDOS, lista);
  pushPedidoUpsert(pedido);
  return pedido;
}

/**
 * Cancela um pedido (o motivo fica registrado e visível no histórico) — não
 * some da lista, só muda de status. Diferente de "recebido"/"parcial", um
 * pedido cancelado nunca é recalculado automaticamente por recebimento.
 */
export function cancelarPedido(id, motivo) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const pedido = lista.find((p) => p.id === id);
  if (!pedido) return null;
  pedido.status = 'cancelado';
  pedido.motivoCancelamento = motivo;
  pedido.atualizadoEm = new Date().toISOString();
  salvar(CHAVE_PEDIDOS, lista);
  pushPedidoUpsert(pedido);
  return pedido;
}

/**
 * Edita um pedido já criado — fornecedor e/ou a lista de itens (permite
 * corrigir quantidade/custo, remover item, ou adicionar um item que ficou de
 * fora na hora de montar a ordem original). O status é recalculado a partir
 * do novo total pedido x já recebido, a não ser que o pedido esteja
 * cancelado (edição não reabre um pedido cancelado).
 */
export function editarPedido(id, { fornecedor, itens }) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const pedido = lista.find((p) => p.id === id);
  if (!pedido) return null;
  if (fornecedor !== undefined) pedido.fornecedor = fornecedor;
  if (itens !== undefined) pedido.itens = itens;
  // Pedido alterado depois de enviado volta pra pendente: o fornecedor recebeu
  // outra versão, então precisa reemitir o PDF e enviar de novo.
  if (pedido.status === 'enviado') pedido.status = 'pendente';
  recalcularStatus(pedido);
  pedido.atualizadoEm = new Date().toISOString();
  salvar(CHAVE_PEDIDOS, lista);
  pushPedidoUpsert(pedido);
  return pedido;
}

function chaveNome(nome) {
  return String(nome ?? '').trim().toLowerCase();
}

/** Pedido pendente do mesmo fornecedor, sem nada recebido ainda, onde dá pra juntar itens (o mais recente). */
function pedidoDestinoElegivel(lista, fornecedor, ignorarId) {
  const chave = chaveNome(fornecedor);
  return lista
    .filter((p) => p.id !== ignorarId && p.status === 'pendente' && chaveNome(p.fornecedor) === chave
      && p.itens.every((i) => (i.qtdRecebida ?? 0) === 0))
    .sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1))[0] ?? null;
}

function juntarItensAoPedido(destinoId, novos) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const destino = lista.find((p) => p.id === destinoId);
  if (!destino) return null;
  for (const novo of novos) {
    const existente = destino.itens.find((i) => i.codigo === novo.codigo);
    if (existente) existente.qtdPedida = (Number(existente.qtdPedida) || 0) + (Number(novo.qtdPedida) || 0);
    else destino.itens.push({ ...novo, qtdRecebida: 0 });
  }
  recalcularStatus(destino);
  destino.atualizadoEm = new Date().toISOString();
  salvar(CHAVE_PEDIDOS, lista);
  pushPedidoUpsert(destino);
  return destino;
}

/**
 * Edição do histórico com fornecedor por item. Cada item pode ter `destino`
 * (nome de outro fornecedor); os itens de cada fornecedor viram um pedido:
 *  - os do fornecedor do próprio pedido ficam nele (se nenhum ficar, o pedido
 *    assume o fornecedor do primeiro grupo);
 *  - os de outro fornecedor vão pra um pedido novo, ou são juntados a um
 *    pedido pendente já existente daquele fornecedor, se `confirmarJuntar`
 *    (nome, pedidoDestino, ehOPedidoEditado) devolver true;
 *  - se o fornecedor do próprio pedido foi trocado pra um que já tem pedido
 *    pendente e a pessoa aceita juntar, este pedido é cancelado como
 *    "unificado" (nada é apagado — o histórico continua).
 * Item já recebido (total ou em parte) não muda de fornecedor.
 * Devolve { resumo: [texto...] } com o que aconteceu além da edição simples.
 */
export function editarPedidoComDestinos(id, { fornecedor, itens }, confirmarJuntar = () => false) {
  const lista = ler(CHAVE_PEDIDOS, []);
  const pedido = lista.find((p) => p.id === id);
  if (!pedido) return null;
  const nomePedido = String(fornecedor ?? pedido.fornecedor).trim() || 'A definir';
  const resumo = [];

  const grupos = new Map();
  for (const { destino, ...item } of itens) {
    const destinoValido = (item.qtdRecebida ?? 0) > 0 ? '' : String(destino ?? '').trim();
    const nome = destinoValido || nomePedido;
    const chave = chaveNome(nome);
    if (!grupos.has(chave)) grupos.set(chave, { nome, itens: [] });
    grupos.get(chave).itens.push(item);
  }
  if (grupos.size === 0) {
    editarPedido(id, { fornecedor: nomePedido, itens: [] });
    return { resumo };
  }

  const chavePrincipal = grupos.has(chaveNome(nomePedido)) ? chaveNome(nomePedido) : grupos.keys().next().value;
  const principal = grupos.get(chavePrincipal);
  grupos.delete(chavePrincipal);

  const mudouFornecedor = chaveNome(principal.nome) !== chaveNome(pedido.fornecedor);
  const destinoPrincipal = mudouFornecedor ? pedidoDestinoElegivel(lista, principal.nome, id) : null;
  if (destinoPrincipal && confirmarJuntar(principal.nome, destinoPrincipal, true)) {
    juntarItensAoPedido(destinoPrincipal.id, principal.itens);
    cancelarPedido(id, `Unificado ao pedido pendente de ${destinoPrincipal.fornecedor} (${new Date(destinoPrincipal.criadoEm).toLocaleDateString('pt-BR')}).`);
    resumo.push(`Itens juntados ao pedido pendente de ${principal.nome}. Este pedido ficou como cancelado (unificado).`);
  } else {
    editarPedido(id, { fornecedor: principal.nome, itens: principal.itens });
  }

  for (const grupo of grupos.values()) {
    const destino = pedidoDestinoElegivel(ler(CHAVE_PEDIDOS, []), grupo.nome, id);
    if (destino && confirmarJuntar(grupo.nome, destino, false)) {
      juntarItensAoPedido(destino.id, grupo.itens);
      resumo.push(`${grupo.itens.length} item(ns) juntados ao pedido pendente de ${grupo.nome}.`);
    } else {
      criarPedido({ fornecedor: grupo.nome, itens: grupo.itens, observacoes: pedido.observacoes });
      resumo.push(`${grupo.itens.length} item(ns) foram para um novo pedido de ${grupo.nome}.`);
    }
  }
  return { resumo };
}

/**
 * Soma, entre todos os pedidos ainda não totalmente recebidos, quanto de um
 * determinado código já está "a caminho" — usado no motor de alertas para
 * não sugerir comprar de novo o que já foi pedido.
 */
export function getPedidosPendentesPorCodigo(codigo) {
  const lista = ler(CHAVE_PEDIDOS, []);
  let pendente = 0;
  for (const pedido of lista) {
    if (pedido.status === 'recebido' || pedido.status === 'cancelado') continue;
    const item = pedido.itens.find((i) => i.codigo === codigo);
    if (item) {
      pendente += Math.max(0, item.qtdPedida - (item.qtdRecebida ?? 0));
    }
  }
  return pendente;
}

/**
 * Versão em lote de getPedidosPendentesPorCodigo: lê o localStorage UMA vez
 * e devolve um mapa { codigo: quantidadePendente }. Usada pelo motor de
 * alertas para classificar milhares de itens sem reabrir o localStorage a
 * cada item (isso sozinho já travava a tela com o catálogo completo).
 */
export function getPedidosPendentesMapa() {
  const lista = ler(CHAVE_PEDIDOS, []);
  const mapa = {};
  for (const pedido of lista) {
    if (pedido.status === 'recebido' || pedido.status === 'cancelado') continue;
    for (const item of pedido.itens) {
      const pendente = Math.max(0, item.qtdPedida - (item.qtdRecebida ?? 0));
      if (pendente > 0) mapa[item.codigo] = (mapa[item.codigo] ?? 0) + pendente;
    }
  }
  return mapa;
}
