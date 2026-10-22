// Unidades que a pessoa escolhe item a item na hora do pedido (ex: o mesmo
// produto pode ser pedido por caixa ou por unidade). A sigla é o que vai pro
// PDF, que tem pouco espaço na coluna — por isso siglas curtas.

export const UNIDADES_PEDIDO = [
  { sigla: 'UN', nome: 'Unidade' },
  { sigla: 'CX', nome: 'Caixa' },
  { sigla: 'PCT', nome: 'Pacote' },
  { sigla: 'PAR', nome: 'Par' },
  { sigla: 'KIT', nome: 'Kit' },
  { sigla: 'FR', nome: 'Frasco' },
  { sigla: 'RL', nome: 'Rolo' },
  { sigla: 'AMP', nome: 'Ampola' },
  { sigla: 'BG', nome: 'Bolsa' },
  { sigla: 'SC', nome: 'Saco' },
  { sigla: 'DZ', nome: 'Dúzia' },
  { sigla: 'GAL', nome: 'Galão' },
  { sigla: 'LT', nome: 'Litro' },
  { sigla: 'MT', nome: 'Metro' },
  { sigla: 'KG', nome: 'Quilo' },
];

// O relatório do Net Use usa variações da mesma unidade (UNI, UND, UD...).
const EQUIVALENTES = {
  UNI: 'UN', UND: 'UN', UD: 'UN', CXA: 'CX', PT: 'PCT', PCE: 'PCT', RLO: 'RL', GA: 'GAL', GL: 'GAL',
};

/** Unidade inicial de um item: a do cadastro (normalizada) ou UN quando vazia/desconhecida ("-"). */
export function unidadePadrao(unidadeDoCadastro) {
  const bruta = String(unidadeDoCadastro ?? '').trim().toUpperCase();
  if (!bruta || bruta === '-') return 'UN';
  return EQUIVALENTES[bruta] ?? bruta;
}

/** Opções do seletor; se a unidade atual não estiver na lista (ex: "PC"), ela entra no topo pra não sumir. */
export function opcoesUnidade(atual) {
  const sigla = String(atual ?? '').trim().toUpperCase();
  if (!sigla || UNIDADES_PEDIDO.some((u) => u.sigla === sigla)) return UNIDADES_PEDIDO;
  return [{ sigla, nome: 'do cadastro' }, ...UNIDADES_PEDIDO];
}
