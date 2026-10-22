// Parser dos relatórios "Inventário: Estoque x Preço Custo" (Sistema Net Use).
// Os três relatórios (positivo / negativo / zerado) usam o mesmo layout de linha:
//
//   <codigo> <codigo_barras> <descrição do produto...> <unidade> <preço> <qtd> <total>
//
// O texto vem de extração de PDF, então às vezes a unidade cola na última
// palavra da descrição (ex: "...FR.500ML (FRESENIUSFA" -> unidade "FA" colada).
// Por isso cada linha recebe um nível de confiança — linhas de baixa confiança
// aparecem no painel de conferência para revisão manual antes de virarem alerta.

export const UNIDADES_CONHECIDAS = [
  'UN', 'UNI', 'UND', 'UD', 'PAR', 'PA', 'PR', 'CX', 'CXA', 'KIT', 'KT',
  'PC', 'PCT', 'PCE', 'PT', 'AMP', 'AM', 'LT', 'GAL', 'GA', 'GL', 'RL', 'RLO', 'MT',
  'FA', 'BSA', 'CPR', 'CP', 'CPS', 'CAP', 'CMP', 'COM', 'KG', 'L', 'RA',
  'FR', 'FRS', 'FC', 'AP', 'ENV', 'TB', 'BG', 'BS', 'BIS', 'VD', 'PÇ',
  'DZ', 'DUZ', 'BO', 'CJ', 'POT', 'JG', 'SC', 'BD', 'EST', 'LTA', 'FD',
  'SER', 'ES',
];

// O relatório Net Use imprime "Código" e "Barras/Ref." colados, sem espaço,
// como um único token: "270270" (código 270 + ref. 270 repetida) ou
// "10077789654492668" (código 10077 + código de barras EAN de 12 dígitos).
// Esta função separa os dois quando possível; se não conseguir, devolve o
// bruto inteiro como código (ainda assim único e estável entre importações).
export function separarCodigoEBarras(bruto) {
  const s = String(bruto);

  // Caso 1: código repetido duas vezes (ex: "270270", "17641764")
  if (s.length % 2 === 0) {
    const meio = s.length / 2;
    const a = s.slice(0, meio);
    const b = s.slice(meio);
    if (a === b && /^\d+$/.test(a)) {
      return { codigo: a, codigoBarras: b };
    }
  }

  // Caso 2: código curto + código de barras longo (12 ou 13 dígitos, tipo EAN)
  for (const tamanhoBarras of [12, 13]) {
    if (s.length > tamanhoBarras) {
      const prefixo = s.slice(0, s.length - tamanhoBarras);
      const sufixo = s.slice(-tamanhoBarras);
      if (/^\d{1,7}$/.test(prefixo) && /^\d+$/.test(sufixo)) {
        return { codigo: prefixo, codigoBarras: sufixo };
      }
    }
  }

  // Caso 3: não foi possível separar — usa o bruto como código (ainda único)
  return { codigo: s, codigoBarras: null };
}

// Converte número no formato BR ("1.234,56" ou "-3,00") para float.
function parseNumeroBR(token) {
  if (token == null) return null;
  const limpo = token.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return Number.isNaN(n) ? null : n;
}

function pareceNumeroBR(token) {
  return /^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(token) || /^-?\d+,\d{2}$/.test(token);
}

// Linhas de cabeçalho/rodapé a ignorar
const LINHAS_IGNORAR = [
  /^Inventário/i,
  /^Sistema Net Use/i,
  /^Emitido em/i,
  /^IC SUPRA HOSPITALAR/i,
  /^IC L LOPES/i,
  /^R COELHO DE RESENDE/i,
  /^CNPJ/i,
  /^Fone/i,
  /^Código Barras/i,
  /^Pagina/i,
  /^Inventario por Estoque/i,
  /^-{5,}/,
  /^_{5,}/,
  /^\d+$/, // número de página solto
  /^TOTAIS\s*:/i,
];

function deveIgnorar(linha) {
  const l = linha.trim();
  if (!l) return true;
  return LINHAS_IGNORAR.some((re) => re.test(l));
}

/**
 * Faz o parse de uma linha de item.
 * Retorna null se a linha não for um item (cabeçalho/rodapé/vazia).
 */
function parseLinha(linhaOriginal) {
  const linha = linhaOriginal.trim();
  if (deveIgnorar(linha)) return null;

  const tokens = linha.split(/\s+/);
  if (tokens.length < 5) return null;

  // Os últimos 3 tokens devem ser preço, quantidade e total (formato BR)
  const tail = tokens.slice(-3);
  if (!tail.every(pareceNumeroBR)) return null;

  const [precoStr, qtdStr, totalStr] = tail;
  const preco = parseNumeroBR(precoStr);
  const quantidade = parseNumeroBR(qtdStr);
  const total = parseNumeroBR(totalStr);

  const { codigo, codigoBarras } = separarCodigoEBarras(tokens[0]);
  const meio = tokens.slice(1, tokens.length - 3); // descrição + unidade colada no fim

  if (meio.length === 0) return null;

  let unidade = '';
  let descricaoTokens = meio;
  let confianca = 'alta';
  let motivoBaixaConfianca = null;

  const ultimaPalavra = meio[meio.length - 1];

  if (UNIDADES_CONHECIDAS.includes(ultimaPalavra)) {
    unidade = ultimaPalavra;
    descricaoTokens = meio.slice(0, -1);
  } else {
    // tenta achar uma unidade conhecida colada como sufixo da última palavra
    const sufixo = UNIDADES_CONHECIDAS.find(
      (u) => ultimaPalavra.endsWith(u) && ultimaPalavra.length > u.length
    );
    if (sufixo) {
      unidade = sufixo;
      const palavraSemSufixo = ultimaPalavra.slice(0, -sufixo.length);
      descricaoTokens = [...meio.slice(0, -1), palavraSemSufixo];
    } else {
      // não deu pra identificar a unidade — não é um problema de dado (a
      // classificação por setor usa a descrição, não a unidade), então só
      // mostramos "-" sem marcar a linha para conferência.
      unidade = '-';
    }
  }

  const descricao = descricaoTokens.join(' ').trim();

  // Confere consistência preço x quantidade x total (tolerância de 1 centavo por unidade).
  // Esse sim é um risco real de dado errado, então continua gerando aviso.
  const totalEsperado = Math.round(preco * quantidade * 100) / 100;
  const diff = Math.abs(totalEsperado - total);
  if (diff > Math.max(0.02, Math.abs(quantidade) * 0.005)) {
    confianca = 'media';
    motivoBaixaConfianca = 'O total não bate exatamente com preço × quantidade — confira.';
  }

  return {
    codigo,
    codigoBarras,
    descricao,
    unidade,
    precoCusto: preco,
    quantidade,
    total,
    confianca,
    motivoBaixaConfianca,
    linhaOriginal: linha,
  };
}

/**
 * Faz o parse do texto completo extraído de um dos relatórios.
 * `origem` identifica o tipo de relatório: 'positivo' | 'negativo' | 'zerado'
 */
export function parseRelatorioEstoque(textoCompleto, origem) {
  const linhas = textoCompleto.split('\n');
  const itens = [];
  const avisos = [];

  for (const linha of linhas) {
    let item;
    try {
      item = parseLinha(linha);
    } catch (e) {
      item = null;
    }
    if (item) {
      itens.push({ ...item, origem });
      if (item.motivoBaixaConfianca) {
        avisos.push({
          codigo: item.codigo,
          descricao: item.descricao,
          motivo: item.motivoBaixaConfianca,
          linhaOriginal: item.linhaOriginal,
        });
      }
    }
  }

  return { itens, avisos, origem, totalLinhasProcessadas: linhas.length };
}

/**
 * Une os relatórios (positivo, negativo, zerado) num único snapshot de estoque.
 *
 * `herdados` traz, pra cada tipo que NÃO foi importado agora, o último
 * relatório desse tipo já importado antes ({ itens, data }). Eles entram
 * primeiro, e qualquer relatório recente sobrescreve: um produto que aparece
 * agora no positivo ou no zerado deixa de ser o "negativo antigo". O que o
 * relatório novo não traz continua como estava (ex: item negativo cujo
 * relatório não foi reimportado). Entre relatórios do mesmo grupo, o positivo
 * tem prioridade, depois o zerado, depois o negativo.
 *
 * `fontes` registra de onde veio cada tipo (data e se foi herdado), pra tela
 * mostrar "negativos: relatório de 08/10".
 */
export function unificarSnapshot({ positivo, negativo, zerado, herdados = {} }) {
  const mapa = new Map();
  const recentes = { positivo, negativo, zerado };
  const ordemPrioridade = ['negativo', 'zerado', 'positivo']; // positivo sobrescreve por último

  for (const tipo of ordemPrioridade) {
    for (const item of herdados[tipo]?.itens ?? []) mapa.set(item.codigo, item);
  }
  for (const tipo of ordemPrioridade) {
    for (const item of recentes[tipo]?.itens ?? []) mapa.set(item.codigo, item);
  }

  const itens = Array.from(mapa.values());
  const avisos = [
    ...(positivo?.avisos ?? []),
    ...(negativo?.avisos ?? []),
    ...(zerado?.avisos ?? []),
  ];

  const geradoEm = new Date().toISOString();
  const fontes = {};
  for (const tipo of ordemPrioridade) {
    const quantidade = itens.filter((i) => i.origem === tipo).length;
    if (recentes[tipo]) fontes[tipo] = { data: geradoEm, herdado: false, itens: quantidade };
    else if (herdados[tipo]) fontes[tipo] = { data: herdados[tipo].data, herdado: true, itens: quantidade };
  }

  const resumo = {
    totalItens: itens.length,
    valorTotalEstoque: itens.reduce((s, i) => s + (i.total > 0 ? i.total : 0), 0),
    itensNegativos: itens.filter((i) => i.quantidade < 0).length,
    itensZerados: itens.filter((i) => i.quantidade === 0).length,
    itensPositivos: itens.filter((i) => i.quantidade > 0).length,
  };

  return { itens, avisos, resumo, fontes, geradoEm };
}
