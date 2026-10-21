// Rascunho da ordem de compra em andamento (itens selecionados, quantidades,
// custos, fornecedores e observações). Vive só neste navegador — sobrevive a
// recarregar a página, trocar de aba do sistema e sessão expirada, mas não é
// compartilhado com outros usuários nem outros computadores.

const CHAVE = 'ic_supra_rascunho_ordem_v1';

export function lerRascunho() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAVE));
    if (!raw || typeof raw !== 'object' || !raw.selecionados) return null;
    return raw;
  } catch {
    return null;
  }
}

export function limparRascunho() {
  try {
    localStorage.removeItem(CHAVE);
  } catch {
    // navegador sem acesso ao storage — nada a limpar
  }
}

/** Devolve o instante salvo (ISO) ou null se não salvou. Sem selecionados não há rascunho, então apaga. */
export function salvarRascunho({ selecionados, campos, observacoes }) {
  if (Object.keys(selecionados).length === 0) {
    limparRascunho();
    return null;
  }
  const atualizadoEm = new Date().toISOString();
  try {
    localStorage.setItem(CHAVE, JSON.stringify({ atualizadoEm, selecionados, campos, observacoes }));
    return atualizadoEm;
  } catch (e) {
    console.warn('[rascunho] Não foi possível salvar o rascunho da ordem de compra.', e);
    return null;
  }
}
