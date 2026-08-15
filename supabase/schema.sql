-- Swilcan CRM database setup. Run once in the Supabase SQL editor.
-- The browser receives only the anon key. Row Level Security restricts all
-- CRM reads and writes to the explicitly authorized accounts.

create table if not exists public.crm_state (
  id smallint primary key default 1 check (id = 1),
  revision bigint not null default 0 check (revision >= 0),
  payload jsonb not null default '{"schemaVersion":2,"prospects":[],"candidates":[]}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.crm_state enable row level security;
alter table public.crm_state force row level security;

drop policy if exists "selena can read crm" on public.crm_state;
drop policy if exists "authorized users can read crm" on public.crm_state;
create policy "authorized users can read crm"
on public.crm_state for select
to authenticated
using (lower(auth.jwt() ->> 'email') in (
  'selena@swilcanforensics.com',
  'bill.mccormick14@gmail.com'
));

drop policy if exists "selena can update crm" on public.crm_state;
drop policy if exists "authorized users can update crm" on public.crm_state;
create policy "authorized users can update crm"
on public.crm_state for update
to authenticated
using (lower(auth.jwt() ->> 'email') in (
  'selena@swilcanforensics.com',
  'bill.mccormick14@gmail.com'
))
with check (lower(auth.jwt() ->> 'email') in (
  'selena@swilcanforensics.com',
  'bill.mccormick14@gmail.com'
));

insert into public.crm_state (id) values (1)
on conflict (id) do nothing;

revoke all on public.crm_state from anon;
grant select, update on public.crm_state to authenticated;
