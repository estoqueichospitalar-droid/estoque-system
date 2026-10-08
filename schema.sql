-- ═══════════════════════════════════════════════════════════════════
-- Schema Supabase — Gestão de Estoque IC Supra Hospitalar
--
-- Rode este script inteiro no SQL Editor do Supabase (Passo 3 do README)
-- para habilitar persistência real entre sessões e múltiplos usuários.
-- Antes disso, o app funciona inteiro em "modo local" (localStorage).
-- ═══════════════════════════════════════════════════════════════════

-- Perfis / papéis de quem usa o sistema
create table if not exists perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  papel text not null check (papel in ('admin', 'comprador', 'visualizador')),
  criado_em timestamptz not null default now()
);

-- Migração: e-mail de contato (independente do login do Supabase Auth) e
-- flag de quem recebe os alertas periódicos por e-mail (ex: estoque negativo).
alter table perfis add column if not exists email text;
alter table perfis add column if not exists recebe_alertas_email boolean not null default false;

-- Um registro por importação de estoque (snapshot)
create table if not exists snapshots_estoque (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  criado_por uuid references perfis(id),
  total_itens integer not null,
  valor_total_estoque numeric(14,2) not null,
  itens_negativos integer not null default 0,
  itens_zerados integer not null default 0,
  itens_positivos integer not null default 0
);

-- Itens de cada snapshot (uma linha por produto por importação)
create table if not exists itens_estoque (
  id bigint generated always as identity primary key,
  snapshot_id uuid not null references snapshots_estoque(id) on delete cascade,
  codigo text not null,
  codigo_barras text,
  descricao text not null,
  unidade text,
  preco_custo numeric(12,2) not null default 0,
  quantidade numeric(12,2) not null default 0,
  total numeric(14,2) not null default 0,
  origem text not null check (origem in ('positivo', 'negativo', 'zerado')),
  confianca text not null default 'alta' check (confianca in ('alta', 'media', 'baixa'))
);
create index if not exists idx_itens_estoque_snapshot on itens_estoque(snapshot_id);
create index if not exists idx_itens_estoque_codigo on itens_estoque(codigo);

-- Configuração manual por produto: estoque mínimo, giro, lead time, fornecedor
create table if not exists config_produtos (
  codigo text primary key,
  estoque_minimo numeric(12,2),
  estoque_minimo_origem text check (estoque_minimo_origem in ('automatico', 'manual')),
  giro_semanal numeric(12,2),
  giro_origem text check (giro_origem in ('automatico', 'manual')),
  lead_time_dias integer,
  margem_seguranca_dias integer,
  fornecedor text,
  setor text,
  descontinuado boolean not null default false,
  atualizado_em timestamptz not null default now()
);

-- Migração pra quem já rodou uma versão anterior deste script (sem a
-- coluna de origem do estoque mínimo) — seguro rodar de novo.
alter table config_produtos add column if not exists estoque_minimo_origem text;
alter table config_produtos drop constraint if exists config_produtos_estoque_minimo_origem_check;
alter table config_produtos add constraint config_produtos_estoque_minimo_origem_check
  check (estoque_minimo_origem in ('automatico', 'manual'));

-- Cadastro de fornecedores — separado de config_produtos porque um mesmo
-- fornecedor atende vários produtos, e um produto pode ter mais de um
-- fornecedor (cada um com seu custo e disponibilidade, ver produto_fornecedor
-- abaixo). `envio_automatico` decide se a Ordem de Compra manda o PDF sozinha
-- pro e-mail cadastrado deste fornecedor ao ser gerada, ou se cai no
-- download manual de sempre — ver src/lib/fornecedores.js.
create table if not exists fornecedores (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text,
  telefone text,
  envio_automatico boolean not null default false,
  ativo boolean not null default true,
  -- Condições comerciais por fornecedor, usadas na Ordem de Compra:
  prazo_pagamento_dias integer,
  -- 'FOB'/'CIF' fixos, ou 'LIMIAR' — acima de frete_limiar (R$) vira CIF,
  -- abaixo fica FOB. Cada fornecedor pode assumir uma modalidade diferente.
  modalidade_frete text check (modalidade_frete in ('FOB', 'CIF', 'LIMIAR')),
  frete_limiar numeric(12,2),
  limite_credito numeric(12,2),
  especialidade text, -- nota livre (ex: "Curativos e material") — só informativo
  setor text, -- um dos valores de SETORES (src/lib/setores.js), ou null ("em aberto")
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Migração pra quem já rodou uma versão anterior deste script.
alter table fornecedores add column if not exists prazo_pagamento_dias integer;
alter table fornecedores add column if not exists modalidade_frete text;
alter table fornecedores drop constraint if exists fornecedores_modalidade_frete_check;
alter table fornecedores add constraint fornecedores_modalidade_frete_check
  check (modalidade_frete in ('FOB', 'CIF', 'LIMIAR'));
alter table fornecedores add column if not exists frete_limiar numeric(12,2);
alter table fornecedores add column if not exists limite_credito numeric(12,2);
alter table fornecedores add column if not exists especialidade text;
alter table fornecedores add column if not exists setor text;

-- Um nome de fornecedor só existe uma vez (sem diferenciar maiúsculas/minúsculas).
-- Evita duplicar a lista padrão quando vários navegadores sincronizam ao mesmo tempo.
create unique index if not exists uq_fornecedores_nome on fornecedores (lower(trim(nome)));

-- Vínculo produto↔fornecedor: custo e disponibilidade são por PAR, não por
-- produto — o mesmo item pode custar diferente e estar disponível em um
-- fornecedor e indisponível em outro. `disponivel = false` é o que permite a
-- Ordem de Compra não fechar o pedido inteiro quando um fornecedor específico
-- não tem aquele item — o item some da conta dele e pode ser resugerido para
-- outro fornecedor cadastrado, sem travar o resto do pedido.
create table if not exists produto_fornecedor (
  id uuid primary key default gen_random_uuid(),
  codigo text not null,
  fornecedor_id uuid not null references fornecedores(id) on delete cascade,
  custo_unitario numeric(12,2),
  disponivel boolean not null default true,
  atualizado_em timestamptz not null default now(),
  unique (codigo, fornecedor_id)
);
create index if not exists idx_produto_fornecedor_codigo on produto_fornecedor(codigo);
create index if not exists idx_produto_fornecedor_fornecedor on produto_fornecedor(fornecedor_id);

-- Pedidos de compra (cabeçalho)
create table if not exists pedidos_compra (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  criado_por uuid references perfis(id),
  fornecedor text not null,
  status text not null default 'pendente' check (status in ('pendente', 'parcial', 'recebido', 'cancelado')),
  observacoes text,
  motivo_cancelamento text,
  pdf_url text
);

-- Migração pra quem já rodou uma versão anterior deste script (sem
-- "cancelado" no status nem a coluna de motivo) — seguro rodar de novo.
alter table pedidos_compra add column if not exists motivo_cancelamento text;
alter table pedidos_compra drop constraint if exists pedidos_compra_status_check;
alter table pedidos_compra add constraint pedidos_compra_status_check
  check (status in ('pendente', 'parcial', 'recebido', 'cancelado'));

-- Itens de cada pedido de compra
create table if not exists itens_pedido_compra (
  id bigint generated always as identity primary key,
  pedido_id uuid not null references pedidos_compra(id) on delete cascade,
  codigo text not null,
  descricao text not null,
  unidade text,
  qtd_pedida numeric(12,2) not null,
  qtd_recebida numeric(12,2) not null default 0,
  custo_unit numeric(12,2) not null default 0
);
create index if not exists idx_itens_pedido_pedido on itens_pedido_compra(pedido_id);

-- Um registro por mês de vendas importado (Mix de Vendas) — reimportar o
-- mesmo mês SUBSTITUI (upsert no cabeçalho + apaga e reinsere os itens),
-- nunca duplica. Mesma lógica de src/lib/historicoVendas.js.
create table if not exists vendas_mensais (
  mes_chave text primary key, -- "2026-06"
  mes_label text not null, -- "Junho/2026"
  periodo_inicio text,
  periodo_fim text,
  resumo jsonb not null default '{}'::jsonb,
  nome_arquivo text,
  importado_em timestamptz not null default now()
);

-- Itens vendidos em cada mês (uma linha por produto por mês)
create table if not exists itens_venda_mensal (
  id bigint generated always as identity primary key,
  mes_chave text not null references vendas_mensais(mes_chave) on delete cascade,
  codigo text not null,
  codigo_barras text,
  descricao text not null,
  unidade text,
  qtde_notas numeric(12,2) not null default 0,
  qtde_volumes numeric(12,2) not null default 0,
  tot_comissoes numeric(14,2) not null default 0,
  tot_vendas numeric(14,2) not null default 0
);
create index if not exists idx_itens_venda_mes on itens_venda_mensal(mes_chave);
create index if not exists idx_itens_venda_codigo on itens_venda_mensal(codigo);

-- Snapshot do alerta no momento em que foi gerado — permite provar
-- "isso já estava sinalizado desde tal data" mesmo depois que o estoque mudar.
create table if not exists alertas_gerados (
  id bigint generated always as identity primary key,
  snapshot_id uuid not null references snapshots_estoque(id) on delete cascade,
  codigo text not null,
  nivel text not null check (nivel in ('NEGATIVO', 'RUPTURA', 'CRITICO', 'ATENCAO', 'MONITORAR', 'OK')),
  dias_cobertura numeric(10,1),
  motivo text,
  criado_em timestamptz not null default now()
);
create index if not exists idx_alertas_snapshot on alertas_gerados(snapshot_id);
create index if not exists idx_alertas_codigo on alertas_gerados(codigo);

-- Row Level Security — agora com login real (Supabase Auth + TelaLogin.jsx).
-- Time interno de 4 pessoas, todas igualmente confiáveis: a regra é só
-- "está autenticado ou não", sem checagem por papel/linha por enquanto.
--
-- Se você já rodou uma versão anterior deste script (fase sem login, com
-- policies `anon_full_access`), rodar este bloco de novo é seguro: os
-- `drop policy if exists` abaixo removem as antigas antes de criar as novas.
-- SÓ rode isso depois que o app com tela de login já estiver publicado e
-- testado — a partir daqui, acesso sem login para de funcionar.
alter table perfis enable row level security;
alter table snapshots_estoque enable row level security;
alter table itens_estoque enable row level security;
alter table config_produtos enable row level security;
alter table pedidos_compra enable row level security;
alter table itens_pedido_compra enable row level security;
alter table alertas_gerados enable row level security;
alter table vendas_mensais enable row level security;
alter table itens_venda_mensal enable row level security;
alter table fornecedores enable row level security;
alter table produto_fornecedor enable row level security;

-- Postgres não tem "CREATE POLICY IF NOT EXISTS" — por isso todo policy
-- aqui é DROP (idempotente) + CREATE, pra este bloco poder ser rodado mais
-- de uma vez sem erro de "já existe".
drop policy if exists anon_full_access on snapshots_estoque;
drop policy if exists anon_full_access on itens_estoque;
drop policy if exists anon_full_access on config_produtos;
drop policy if exists anon_full_access on pedidos_compra;
drop policy if exists anon_full_access on itens_pedido_compra;
drop policy if exists anon_full_access on alertas_gerados;
drop policy if exists anon_full_access on vendas_mensais;
drop policy if exists anon_full_access on itens_venda_mensal;

drop policy if exists authenticated_full_access on snapshots_estoque;
drop policy if exists authenticated_full_access on itens_estoque;
drop policy if exists authenticated_full_access on config_produtos;
drop policy if exists authenticated_full_access on pedidos_compra;
drop policy if exists authenticated_full_access on itens_pedido_compra;
drop policy if exists authenticated_full_access on alertas_gerados;
drop policy if exists authenticated_full_access on vendas_mensais;
drop policy if exists authenticated_full_access on itens_venda_mensal;
drop policy if exists authenticated_full_access on fornecedores;
drop policy if exists authenticated_full_access on produto_fornecedor;
drop policy if exists perfis_leitura_time on perfis;

create policy authenticated_full_access on snapshots_estoque for all to authenticated using (true) with check (true);
create policy authenticated_full_access on itens_estoque for all to authenticated using (true) with check (true);
create policy authenticated_full_access on config_produtos for all to authenticated using (true) with check (true);
create policy authenticated_full_access on pedidos_compra for all to authenticated using (true) with check (true);
create policy authenticated_full_access on itens_pedido_compra for all to authenticated using (true) with check (true);
create policy authenticated_full_access on alertas_gerados for all to authenticated using (true) with check (true);
create policy authenticated_full_access on vendas_mensais for all to authenticated using (true) with check (true);
create policy authenticated_full_access on itens_venda_mensal for all to authenticated using (true) with check (true);
create policy authenticated_full_access on fornecedores for all to authenticated using (true) with check (true);
create policy authenticated_full_access on produto_fornecedor for all to authenticated using (true) with check (true);

-- Qualquer autenticado pode ver o nome/papel dos colegas (só informativo,
-- sem dado sensível) — ninguém escreve em `perfis` pelo app: as 4 linhas
-- entram manualmente via SQL Editor (que roda como dono do banco e ignora
-- RLS), depois que as contas forem criadas em Authentication → Users.
create policy perfis_leitura_time on perfis for select to authenticated using (true);
