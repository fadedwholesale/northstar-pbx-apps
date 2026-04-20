create table if not exists public.northstar_contacts (
  id text primary key,
  business text not null,
  name text,
  phone text,
  city text,
  vertical text,
  stage text,
  last_outcome text,
  updated_at timestamptz default now()
);

create table if not exists public.northstar_activities (
  id text primary key,
  type text not null default 'call',
  agent_id text,
  agent_name text,
  contact_id text,
  business text,
  vertical text,
  disposition text,
  notes text,
  duration_sec integer,
  recording boolean default false,
  created_at timestamptz default now()
);

alter table public.northstar_contacts enable row level security;
alter table public.northstar_activities enable row level security;

drop policy if exists "anon read contacts" on public.northstar_contacts;
drop policy if exists "anon write contacts" on public.northstar_contacts;
drop policy if exists "anon update contacts" on public.northstar_contacts;
drop policy if exists "anon read activities" on public.northstar_activities;
drop policy if exists "anon write activities" on public.northstar_activities;
drop policy if exists "anon update activities" on public.northstar_activities;

create policy "anon read contacts" on public.northstar_contacts
for select to anon using (true);
create policy "anon write contacts" on public.northstar_contacts
for insert to anon with check (true);
create policy "anon update contacts" on public.northstar_contacts
for update to anon using (true) with check (true);

create policy "anon read activities" on public.northstar_activities
for select to anon using (true);
create policy "anon write activities" on public.northstar_activities
for insert to anon with check (true);
create policy "anon update activities" on public.northstar_activities
for update to anon using (true) with check (true);
