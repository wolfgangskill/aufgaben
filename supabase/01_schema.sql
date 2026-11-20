-- ============================================================
-- Teil 1: Datenbank für das Alltags-System (Modul "To-do-Liste")
-- Wird einmal im Supabase "SQL Editor" ausgeführt.
-- ============================================================

-- 1. TABELLE AREAS (Verantwortungsbereiche) ------------------
create table areas (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. TABELLE TASKS (Aufgaben) --------------------------------
-- area_id ist Pflicht. "on delete restrict" verbietet das Löschen
-- einer Area, die noch Aufgaben enthält.
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  area_id      uuid not null references areas(id) on delete restrict,
  title        text not null check (length(trim(title)) > 0),
  status       text not null default 'open' check (status in ('open', 'done')),
  due_date     date,
  priority     smallint not null default 0 check (priority between 0 and 2),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tasks_area_idx     on tasks (area_id);
create index tasks_open_due_idx on tasks (due_date) where status = 'open';

-- 3. AUTOMATIK FÜR ZEITSTEMPEL -------------------------------
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger areas_set_updated_at
  before update on areas
  for each row execute function set_updated_at();

-- Bei Tasks wird zusätzlich completed_at automatisch gesetzt/geleert.
create function tasks_before_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'done' then
      new.completed_at := now();
    end if;
  else
    new.updated_at := now();
    if new.status = 'done' and old.status <> 'done' then
      new.completed_at := now();
    elsif new.status = 'open' then
      new.completed_at := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger tasks_before_write
  before insert or update on tasks
  for each row execute function tasks_before_write();

-- 4. ZUGRIFFSSCHUTZ (Row Level Security) ---------------------
-- Jede Zeile darf nur von ihrem Besitzer gelesen/geändert werden.
alter table areas enable row level security;
alter table tasks enable row level security;

create policy "Eigene Areas" on areas
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Eigene Tasks" on tasks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Angemeldete Nutzer dürfen die Tabellen über die API ansprechen.
grant select, insert, update, delete on areas, tasks to authenticated;

-- Die Edge Function "capture" greift mit dem Server-Schlüssel (service_role) zu.
-- (Wurde nach dem ersten Lauf ergänzt, weil neue Tabellen nicht automatisch freigegeben werden.)
grant select, insert, update, delete on areas, tasks to service_role;
