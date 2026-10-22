// Empurra cada escrita local pro Supabase, em segundo plano — nunca é
// aguardado por quem chama (fire-and-forget) e nunca lança: uma falha aqui
// (rede fora, Supabase não configurado, etc.) não pode quebrar o fluxo local,
// que já terminou de gravar no localStorage antes dessas funções serem
// chamadas. Ver src/lib/sync/pull.js para o caminho inverso.

import { supabase, isSupabaseConfigured, insertChunked, chunk } from '../supabaseClient';

function avisar(contexto, erro) {
  console.warn(`[sync] Falha ao sincronizar ${contexto} com o Supabase — os dados continuam salvos localmente.`, erro);
}

export async function pushConfigProduto(codigo, config) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error } = await supabase.from('config_produtos').upsert({
      codigo,
      estoque_minimo: config.estoqueMinimo ?? null,
      estoque_minimo_origem: config.estoqueMinimoOrigem ?? null,
      giro_semanal: config.giroSemanal ?? null,
      giro_origem: config.giroOrigem ?? null,
      lead_time_dias: config.leadTimeDias ?? null,
      margem_seguranca_dias: config.margemSegurancaDias ?? null,
      fornecedor: config.fornecedor ?? null,
      setor: config.setor ?? null,
      descontinuado: !!config.descontinuado,
      atualizado_em: config.atualizadoEm ?? new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    avisar(`config do produto ${codigo}`, e);
  }
}

/**
 * Versão em lote de pushConfigProduto — usada por importarConfigsEmLote()
 * (ex: "marcar setor como descontinuado" pode afetar centenas de produtos
 * de uma vez). Um upsert só com todas as linhas, em vez de uma chamada de
 * rede por produto.
 */
export async function pushConfigsEmLote(mapaCodigoConfig, todosResolvidos) {
  if (!isSupabaseConfigured()) return;
  try {
    const linhas = Object.keys(mapaCodigoConfig).map((codigo) => {
      const config = todosResolvidos[codigo];
      return {
        codigo,
        estoque_minimo: config.estoqueMinimo ?? null,
        estoque_minimo_origem: config.estoqueMinimoOrigem ?? null,
        giro_semanal: config.giroSemanal ?? null,
        giro_origem: config.giroOrigem ?? null,
        lead_time_dias: config.leadTimeDias ?? null,
        margem_seguranca_dias: config.margemSegurancaDias ?? null,
        fornecedor: config.fornecedor ?? null,
        setor: config.setor ?? null,
        descontinuado: !!config.descontinuado,
        atualizado_em: config.atualizadoEm ?? new Date().toISOString(),
      };
    });
    for (const lote of chunk(linhas, 500)) {
      const { error } = await supabase.from('config_produtos').upsert(lote);
      if (error) throw error;
    }
  } catch (e) {
    avisar(`lote de configs (${Object.keys(mapaCodigoConfig).length} produtos)`, e);
  }
}

export async function pushRemoverConfigProduto(codigo) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error } = await supabase.from('config_produtos').delete().eq('codigo', codigo);
    if (error) throw error;
  } catch (e) {
    avisar(`remoção da config do produto ${codigo}`, e);
  }
}

export async function pushSnapshot(registro) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error: erroCabecalho } = await supabase.from('snapshots_estoque').upsert({
      id: registro.id,
      criado_em: registro.criadoEm,
      total_itens: registro.resumo.totalItens,
      valor_total_estoque: registro.resumo.valorTotalEstoque,
      itens_negativos: registro.resumo.itensNegativos,
      itens_zerados: registro.resumo.itensZerados,
      itens_positivos: registro.resumo.itensPositivos,
      fontes: registro.fontes ?? null,
    });
    if (erroCabecalho) throw erroCabecalho;

    await insertChunked('itens_estoque', registro.itens.map((i) => ({
      snapshot_id: registro.id,
      codigo: i.codigo,
      codigo_barras: i.codigoBarras ?? null,
      descricao: i.descricao,
      unidade: i.unidade || null,
      preco_custo: i.precoCusto ?? 0,
      quantidade: i.quantidade ?? 0,
      total: i.total ?? 0,
      origem: i.origem,
      confianca: i.confianca ?? 'alta',
    })));
  } catch (e) {
    avisar(`snapshot de estoque ${registro.id}`, e);
  }
}

export async function pushPedidoUpsert(pedido) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error: erroCabecalho } = await supabase.from('pedidos_compra').upsert({
      id: pedido.id,
      criado_em: pedido.criadoEm,
      atualizado_em: pedido.atualizadoEm ?? new Date().toISOString(),
      fornecedor: pedido.fornecedor,
      status: pedido.status,
      observacoes: pedido.observacoes ?? null,
      motivo_cancelamento: pedido.motivoCancelamento ?? null,
    });
    if (erroCabecalho) throw erroCabecalho;

    // itens de um pedido são poucos (dezenas) — mais simples e seguro
    // apagar e reinserir do que fazer upsert item a item sem chave natural.
    const { error: erroDelete } = await supabase.from('itens_pedido_compra').delete().eq('pedido_id', pedido.id);
    if (erroDelete) throw erroDelete;

    await insertChunked('itens_pedido_compra', pedido.itens.map((i) => ({
      pedido_id: pedido.id,
      codigo: i.codigo,
      descricao: i.descricao,
      unidade: i.unidade || null,
      qtd_pedida: i.qtdPedida,
      qtd_recebida: i.qtdRecebida ?? 0,
      custo_unit: i.custoUnit ?? 0,
    })));
  } catch (e) {
    avisar(`pedido de compra ${pedido.id}`, e);
  }
}

export async function pushVendasMes(registro) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error: erroCabecalho } = await supabase.from('vendas_mensais').upsert({
      mes_chave: registro.mesChave,
      mes_label: registro.mesLabel,
      periodo_inicio: registro.periodoInicio ?? null,
      periodo_fim: registro.periodoFim ?? null,
      resumo: registro.resumo ?? {},
      nome_arquivo: registro.nomeArquivo ?? null,
      importado_em: registro.importadoEm,
    });
    if (erroCabecalho) throw erroCabecalho;

    // reimportar um mês substitui os itens — apaga tudo daquele mês antes.
    const { error: erroDelete } = await supabase.from('itens_venda_mensal').delete().eq('mes_chave', registro.mesChave);
    if (erroDelete) throw erroDelete;

    await insertChunked('itens_venda_mensal', registro.itens.map((i) => ({
      mes_chave: registro.mesChave,
      codigo: i.codigo,
      codigo_barras: i.codigoBarras ?? null,
      descricao: i.descricao,
      unidade: i.unidade || null,
      qtde_notas: i.qtdeNotas ?? 0,
      qtde_volumes: i.qtdeVolumes ?? 0,
      tot_comissoes: i.totComissoes ?? 0,
      tot_vendas: i.totVendas ?? 0,
    })));
  } catch (e) {
    avisar(`vendas do mês ${registro.mesChave}`, e);
  }
}

export async function pushRemoverVendasMes(mesChave) {
  if (!isSupabaseConfigured()) return;
  try {
    // cascade em itens_venda_mensal cuida dos itens
    const { error } = await supabase.from('vendas_mensais').delete().eq('mes_chave', mesChave);
    if (error) throw error;
  } catch (e) {
    avisar(`remoção do mês de vendas ${mesChave}`, e);
  }
}

export async function pushFornecedorUpsert(fornecedor) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error } = await supabase.from('fornecedores').upsert({
      id: fornecedor.id,
      nome: fornecedor.nome,
      email: fornecedor.email ?? null,
      telefone: fornecedor.telefone ?? null,
      envio_automatico: !!fornecedor.envioAutomatico,
      ativo: fornecedor.ativo !== false,
      prazo_pagamento_dias: fornecedor.prazoPagamentoDias ?? null,
      modalidade_frete: fornecedor.modalidadeFrete ?? null,
      frete_limiar: fornecedor.freteLimiar ?? null,
      limite_credito: fornecedor.limiteCredito ?? null,
      especialidade: fornecedor.especialidade ?? null,
      setor: fornecedor.setor ?? null,
      criado_em: fornecedor.criadoEm,
      atualizado_em: fornecedor.atualizadoEm ?? new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    avisar(`fornecedor ${fornecedor.nome}`, e);
  }
}

export async function pushVinculoUpsert(vinculo) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error } = await supabase.from('produto_fornecedor').upsert({
      id: vinculo.id,
      codigo: vinculo.codigo,
      fornecedor_id: vinculo.fornecedorId,
      custo_unitario: vinculo.custoUnitario ?? null,
      disponivel: vinculo.disponivel !== false,
      atualizado_em: vinculo.atualizadoEm ?? new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    avisar(`vínculo produto/fornecedor ${vinculo.codigo}`, e);
  }
}

export async function pushRemoverVinculo(id) {
  if (!isSupabaseConfigured()) return;
  try {
    const { error } = await supabase.from('produto_fornecedor').delete().eq('id', id);
    if (error) throw error;
  } catch (e) {
    avisar(`remoção do vínculo produto/fornecedor ${id}`, e);
  }
}
