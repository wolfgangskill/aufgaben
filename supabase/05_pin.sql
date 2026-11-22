-- ============================================================
-- Teil 4: Notizen anheften
--   pinned_at: Zeitpunkt des Anheftens. Leer = nicht angeheftet.
--   Angeheftete Notizen stehen oben, die zuletzt angeheftete zuerst.
-- Außerdem: Anheften zählt nicht als Bearbeiten. "updated_at" ändert sich jetzt nur,
-- wenn Text oder Area der Notiz geändert werden. Sonst würde eine gelöste Notiz in der
-- Liste nach oben springen, als hättest du sie gerade bearbeitet.
-- Wird einmal im Supabase "SQL Editor" ausgeführt (nach 01 bis 04).
-- ============================================================

alter table notes add column pinned_at timestamptz;

create index notes_pinned_idx on notes (pinned_at desc) where pinned_at is not null;

create or replace function notes_touch() returns trigger
language plpgsql as $$
begin
  if new.body is distinct from old.body or new.area_id is distinct from old.area_id then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger notes_set_updated_at on notes;
create trigger notes_set_updated_at
  before update on notes
  for each row execute function notes_touch();
