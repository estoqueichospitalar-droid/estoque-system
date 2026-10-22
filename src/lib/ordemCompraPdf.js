import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// Azul do fundo da logo (#002060) — faixa do topo, barras de fornecedor e
// totais usam o mesmo tom, pra a logo se fundir ao cabeçalho sem emenda.
const AZUL = rgb(0, 0x20 / 255, 0x60 / 255);
const CINZA_TEXTO = rgb(0x37 / 255, 0x41 / 255, 0x51 / 255);
const CINZA_MUTED = rgb(0x6b / 255, 0x72 / 255, 0x80 / 255);
const CINZA_BORDA = rgb(0xe2 / 255, 0xe5 / 255, 0xea / 255);
const VERMELHO = rgb(0x99 / 255, 0x1b / 255, 0x1b / 255);
const BRANCO = rgb(1, 1, 1);

const MARGEM = 40;
const LARGURA_PAGINA = 595.28; // A4
const ALTURA_PAGINA = 841.89;
const ALTURA_CABECALHO = 84;
// A imagem da logo (public/logo-ic-pdf.png) já traz o fundo azul e uma
// pequena folga à esquerda; este recuo alinha a marca com a margem do texto.
const RECUO_LOGO = 12;

/** Logo do cabeçalho do PDF, já com o fundo azul da marca. */
export async function carregarLogoPdf() {
  const resposta = await fetch('/logo-ic-pdf.png');
  return new Uint8Array(await resposta.arrayBuffer());
}

function fmtMoeda(v) {
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
}

/**
 * Gera o PDF da ordem de compra, uma seção por fornecedor.
 * `grupos` = [{ fornecedor, itens: [{codigo, descricao, unidade, qtd, custoUnit, nivel}] }]
 */
// Quebra um texto livre em linhas que respeitam uma largura máxima, sem
// cortar palavra no meio — necessário porque pdf-lib não faz isso sozinho.
function quebrarLinhas(texto, font, size, larguraMax) {
  const linhas = [];
  for (const paragrafo of texto.split('\n')) {
    let atual = '';
    for (const palavra of paragrafo.split(' ')) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (font.widthOfTextAtSize(tentativa, size) > larguraMax && atual) {
        linhas.push(atual);
        atual = palavra;
      } else {
        atual = tentativa;
      }
    }
    linhas.push(atual);
  }
  return linhas;
}

export async function gerarOrdemCompraPdf({ grupos, referencia, logoBytes, observacoes }) {
  const pdf = await PDFDocument.create();
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let logoImg = null;
  if (logoBytes) {
    try {
      logoImg = await pdf.embedPng(logoBytes);
    } catch {
      logoImg = null;
    }
  }

  let page = pdf.addPage([LARGURA_PAGINA, ALTURA_PAGINA]);
  let y = ALTURA_PAGINA - MARGEM;

  function novaPagina() {
    page = pdf.addPage([LARGURA_PAGINA, ALTURA_PAGINA]);
    y = ALTURA_PAGINA - MARGEM;
    desenharCabecalhoTopo();
  }

  function garantirEspaco(altura) {
    if (y - altura < MARGEM + 40) novaPagina();
  }

  function desenharCabecalhoTopo() {
    page.drawRectangle({
      x: 0, y: ALTURA_PAGINA - ALTURA_CABECALHO, width: LARGURA_PAGINA, height: ALTURA_CABECALHO, color: AZUL,
    });
    if (logoImg) {
      const escala = ALTURA_CABECALHO / logoImg.height;
      page.drawImage(logoImg, {
        x: MARGEM - RECUO_LOGO,
        y: ALTURA_PAGINA - ALTURA_CABECALHO,
        width: logoImg.width * escala,
        height: ALTURA_CABECALHO,
      });
    } else {
      page.drawText('IC SUPRA HOSPITALAR', {
        x: MARGEM, y: ALTURA_PAGINA - 50, size: 16, font: fontBold, color: BRANCO,
      });
    }
    const titulo = 'ORDEM DE COMPRA';
    const larguraTitulo = fontBold.widthOfTextAtSize(titulo, 13);
    page.drawText(titulo, {
      x: LARGURA_PAGINA - MARGEM - larguraTitulo, y: ALTURA_PAGINA - ALTURA_CABECALHO / 2 - 4, size: 13, font: fontBold, color: BRANCO,
    });
    y = ALTURA_PAGINA - ALTURA_CABECALHO - 22;
  }

  desenharCabecalhoTopo();

  page.drawText(`Referência: ${referencia}`, { x: MARGEM, y, size: 9, font: fontRegular, color: CINZA_MUTED });
  y -= 12;
  page.drawText(`Emitido em: ${new Date().toLocaleDateString('pt-BR')}`, { x: MARGEM, y, size: 9, font: fontRegular, color: CINZA_MUTED });
  y -= 24;

  let valorTotalGeral = 0;

  for (let i = 0; i < grupos.length; i++) {
    const grupo = grupos[i];
    // Cada fornecedor começa numa folha nova — nunca dois fornecedores na
    // mesma página. O primeiro segue na página do cabeçalho inicial; os
    // demais forçam quebra de página incondicional (não só "se não couber").
    if (i > 0) novaPagina();

    // Cabeçalho do fornecedor
    page.drawRectangle({ x: MARGEM, y: y - 20, width: LARGURA_PAGINA - 2 * MARGEM, height: 22, color: AZUL });
    page.drawText(`Fornecedor: ${grupo.fornecedor || 'A definir'}`, {
      x: MARGEM + 8, y: y - 15, size: 11, font: fontBold, color: BRANCO,
    });
    y -= 30;

    // Cabeçalho da tabela
    const colX = { codigo: MARGEM, desc: MARGEM + 55, un: MARGEM + 300, qtd: MARGEM + 340, custo: MARGEM + 400, total: MARGEM + 470 };
    page.drawText('Código', { x: colX.codigo, y, size: 8, font: fontBold, color: CINZA_MUTED });
    page.drawText('Descrição', { x: colX.desc, y, size: 8, font: fontBold, color: CINZA_MUTED });
    page.drawText('Un.', { x: colX.un, y, size: 8, font: fontBold, color: CINZA_MUTED });
    page.drawText('Qtd.', { x: colX.qtd, y, size: 8, font: fontBold, color: CINZA_MUTED });
    page.drawText('Custo Un.', { x: colX.custo, y, size: 8, font: fontBold, color: CINZA_MUTED });
    page.drawText('Total', { x: colX.total, y, size: 8, font: fontBold, color: CINZA_MUTED });
    y -= 6;
    page.drawLine({ start: { x: MARGEM, y }, end: { x: LARGURA_PAGINA - MARGEM, y }, thickness: 0.5, color: CINZA_BORDA });
    y -= 12;

    let valorGrupo = 0;

    for (const item of grupo.itens) {
      garantirEspaco(16);
      const totalItem = item.qtd * item.custoUnit;
      valorGrupo += totalItem;

      const corCritico = item.nivel === 'CRITICO' || item.nivel === 'RUPTURA' ? VERMELHO : CINZA_TEXTO;

      page.drawText(String(item.codigo), { x: colX.codigo, y, size: 8, font: fontRegular, color: corCritico });
      const descCortada = item.descricao.length > 48 ? item.descricao.slice(0, 46) + '…' : item.descricao;
      page.drawText(descCortada, { x: colX.desc, y, size: 8, font: fontRegular, color: corCritico });
      page.drawText(item.unidade || '-', { x: colX.un, y, size: 8, font: fontRegular, color: corCritico });
      page.drawText(String(item.qtd), { x: colX.qtd, y, size: 8, font: fontRegular, color: corCritico });
      page.drawText(fmtMoeda(item.custoUnit), { x: colX.custo, y, size: 8, font: fontRegular, color: corCritico });
      page.drawText(fmtMoeda(totalItem), { x: colX.total, y, size: 8, font: fontRegular, color: corCritico });
      y -= 14;
    }

    y -= 4;
    page.drawLine({ start: { x: MARGEM, y }, end: { x: LARGURA_PAGINA - MARGEM, y }, thickness: 0.5, color: CINZA_BORDA });
    y -= 14;
    page.drawText(`Subtotal ${grupo.fornecedor || 'A definir'}: ${fmtMoeda(valorGrupo)}`, {
      x: LARGURA_PAGINA - MARGEM - 200, y, size: 9, font: fontBold, color: AZUL,
    });
    y -= 26;

    valorTotalGeral += valorGrupo;
  }

  garantirEspaco(40);
  page.drawLine({ start: { x: MARGEM, y }, end: { x: LARGURA_PAGINA - MARGEM, y }, thickness: 1, color: AZUL });
  y -= 18;
  page.drawText(`VALOR TOTAL DA ORDEM DE COMPRA: ${fmtMoeda(valorTotalGeral)}`, {
    x: MARGEM, y, size: 12, font: fontBold, color: AZUL,
  });

  if (observacoes) {
    y -= 28;
    const linhas = quebrarLinhas(observacoes, fontRegular, 9, LARGURA_PAGINA - 2 * MARGEM);
    garantirEspaco(16 + linhas.length * 12);
    page.drawText('Observações', { x: MARGEM, y, size: 9, font: fontBold, color: CINZA_MUTED });
    y -= 14;
    for (const linha of linhas) {
      garantirEspaco(12);
      page.drawText(linha, { x: MARGEM, y, size: 9, font: fontRegular, color: CINZA_TEXTO });
      y -= 12;
    }
  }

  return pdf.save();
}

export function baixarPdf(bytes, nomeArquivo) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
