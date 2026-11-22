-- ============================================================
-- Teil 2: Suche über Aufgaben und Notizen
--   1. Wortstammerkennung (Deutsch): "Termine" findet "Termin"
--   2. Wortteil-Suche als Ergänzung: "konzert" findet "Sommerkonzert"
-- Wird einmal im Supabase "SQL Editor" ausgeführt (nach 01 und 02).
-- ============================================================

-- Suchspalten: Die Datenbank füllt sie automatisch aus Titel bzw. Text.
alter table tasks add column search tsvector
  generated always as (to_tsvector('german', title)) stored;
alter table notes add column search tsvector
  generated always as (to_tsvector('german', body)) stored;

create index tasks_search_idx on tasks using gin (search);
create index notes_search_idx on notes using gin (search);

-- Eine Suchfunktion für beides. Sie läuft mit den Rechten des angemeldeten Nutzers
-- (security invoker), der Zeilenschutz gilt also: man findet nur eigene Einträge.
create or replace function search_all(q text)
returns table (
  kind text, id uuid, area_id uuid, head text, snippet text,
  status text, due_date date, priority smallint, updated_at timestamptz, stem_match boolean
)
language sql stable security invoker set search_path = public
as $$
  with qq as (
    select websearch_to_tsquery('german', q) as tsq,
           lower(btrim(q)) as needle,
           -- Sonderzeichen für LIKE entschärfen
           '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ), hits as (
    select 'task'::text as kind, t.id, t.area_id, t.title as head, t.title as full_text,
           t.status, t.due_date, t.priority, t.updated_at,
           (t.search @@ qq.tsq) as stem_match, ts_rank(t.search, qq.tsq) as rank
    from tasks t, qq
    where length(btrim(q)) >= 2 and ((t.search @@ qq.tsq) or t.title ilike qq.pat)
    union all
    select 'note', n.id, n.area_id, left(n.body, 300), n.body,
           null, null, null, n.updated_at,
           (n.search @@ qq.tsq), ts_rank(n.search, qq.tsq)
    from notes n, qq
    where length(btrim(q)) >= 2 and ((n.search @@ qq.tsq) or n.body ilike qq.pat)
    order by stem_match desc, rank desc, updated_at desc
    limit 100
  )
  select h.kind, h.id, h.area_id, h.head,
         case
           -- Treffer über Wortstamm: Fundstelle mit Markierung «…»
           when h.stem_match then ts_headline('german', h.full_text, (select tsq from qq),
                'StartSel=«, StopSel=», MaxWords=22, MinWords=8, ShortWord=2, MaxFragments=1')
           -- Treffer nur über Wortteil: Ausschnitt rund um die Fundstelle
           else substr(h.full_text,
                greatest(position((select needle from qq) in lower(h.full_text)) - 40, 1), 140)
         end as snippet,
         h.status, h.due_date, h.priority, h.updated_at, h.stem_match
  from hits h
  order by h.stem_match desc, h.rank desc, h.updated_at desc;
$$;

-- Nur angemeldete Nutzer dürfen suchen (nicht der anonyme Zugang).
revoke execute on function search_all(text) from public, anon;
grant execute on function search_all(text) to authenticated;
