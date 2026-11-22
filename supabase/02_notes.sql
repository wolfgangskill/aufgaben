-- ============================================================
-- Teil 1 der Notizen: Tabelle "notes"
-- Wird einmal im Supabase "SQL Editor" ausgeführt (nach 01_schema.sql).
-- Spätere Teile (Suche, Tags, Anheften, Verknüpfungen, Anhänge) kommen als eigene Dateien.
-- ============================================================

create table notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Pflicht-Area; eine Area mit Notizen lässt sich nicht löschen (wie bei Aufgaben)
  area_id    uuid not null references areas(id) on delete restrict,
  -- Dein einziges Textfeld. Formatierung steckt als Markdown im Text selbst.
  body       text not null
             check (length(regexp_replace(body, '\s', '', 'g')) > 0 and length(body) <= 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_area_idx on notes (area_id, updated_at desc);

-- updated_at wird bei jeder Änderung automatisch gesetzt (Funktion aus 01_schema.sql)
create trigger notes_set_updated_at
  before update on notes
  for each row execute function set_updated_at();

-- Zugriffsschutz: jede Notiz gehört ihrem Besitzer
alter table notes enable row level security;

create policy "Eigene Notizen" on notes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Rechte für angemeldete Nutzer (App) und für die Server-Funktion "capture"
grant select, insert, update, delete on notes to authenticated;
grant select, insert, update, delete on notes to service_role;

-- Aufräumen: Supabase vergibt von selbst zusätzliche Rechte (z. B. TRUNCATE, auch an "anon").
-- Die App braucht sie nicht, deshalb entziehen wir sie für alle drei Tabellen.
revoke all on areas, tasks, notes from anon;
revoke truncate, references, trigger on areas, tasks, notes from authenticated;
