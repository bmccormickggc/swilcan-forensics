drop policy if exists "selena can read crm" on public.crm_state;
drop policy if exists "selena can update crm" on public.crm_state;
drop policy if exists "authorized users can read crm" on public.crm_state;
drop policy if exists "authorized users can update crm" on public.crm_state;

create policy "authorized users can read crm"
on public.crm_state for select
to authenticated
using (lower(auth.jwt() ->> 'email') in (
  'selena@swilcanforensics.com',
  'bill.mccormick14@gmail.com'
));

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
