-- ============================================================
-- Teil 3: Tags für Aufgaben und Notizen
--   tags        = die Schlagwörter (jedes nur einmal, ohne Unterschied zwischen Groß/Klein)
--   task_tags   = Verbindung Aufgabe <-> Tag
--   note_tags   = Verbindung Notiz <-> Tag
-- Außerdem: Die Suche (search_all) kennt jetzt Tags.
--   "#Elternabend" in der Suche zeigt alles mit diesem Tag; normale Suchwörter finden auch Tag-Namen.
-- Wird einmal im Supabase "SQL Editor" ausgeführt (nach 01 bis 03).
-- ============================================================

create table tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (name = btrim(name) and length(name) between 1 and 40 and name !~ '[,#]'),
  created_at timestamptz not null default now()
);
-- Jeder Name nur einmal pro Nutzer, "Schule" und "schule" sind derselbe Tag
create unique index tags_user_name_idx on tags (user_id, lower(name));

create table task_tags (
  task_id uuid not null references tasks(id) on delete cascade,
  tag_id  uuid not null references tags(id)  on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (task_id, tag_id)
);
create index task_tags_tag_idx on task_tags (tag_id);

create table note_tags (
  note_id uuid not null references notes(id) on delete cascade,
  tag_id  uuid not null references tags(id)  on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  primary key (note_id, tag_id)
);
create index note_tags_tag_idx on note_tags (tag_id);

-- Zugriffsschutz: alles gehört dem Besitzer
alter table tags      enable row level security;
alter table task_tags enable row level security;
alter table note_tags enable row level security;

create policy "Eigene Tags" on tags
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Eigene Aufgaben-Tags" on task_tags
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Eigene Notiz-Tags" on note_tags
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Rechte: so wenig wie nötig. (Supabase vergibt von selbst mehr; das entziehen wir wieder.)
revoke all on tags, task_tags, note_tags from anon;
grant select, insert, update, delete on tags to authenticated;
grant select, insert, delete on task_tags, note_tags to authenticated;
revoke truncate, references, trigger on tags, task_tags, note_tags from authenticated;
grant select, insert, update, delete on tags, task_tags, note_tags to service_role;

-- ------------------------------------------------------------
-- Suche erweitern: Tags anzeigen, "#tag" als Filter, Tag-Namen als Suchtreffer.
-- Die Rückgabe bekommt eine Spalte mehr, deshalb zuerst die alte Funktion entfernen.
-- ------------------------------------------------------------
drop function if exists search_all(text);

create function search_all(q text)
returns table (
  kind text, id uuid, area_id uuid, head text, snippet text,
  status text, due_date date, priority smallint, updated_at timestamptz, stem_match boolean,
  tags text[]
)
language sql stable security invoker set search_path = public
as $$
  with qq as (
    select websearch_to_tsquery('german', q) as tsq,
           lower(btrim(q)) as needle,
           left(btrim(q), 1) = '#' as is_tag,
           lower(btrim(substr(btrim(q), 2))) as tagname,
           '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ), hits as (
    select 'task'::text as kind, t.id, t.area_id, t.title as head, t.title as full_text,
           t.status, t.due_date, t.priority, t.updated_at,
           ((t.search @@ qq.tsq) and not qq.is_tag) as stem_match, ts_rank(t.search, qq.tsq) as rank,
           array(select g.name from task_tags x join tags g on g.id = x.tag_id
                 where x.task_id = t.id order by g.name) as tags
    from tasks t, qq
    where length(btrim(q)) >= 2 and (
      case when qq.is_tag then
        exists (select 1 from task_tags x join tags g on g.id = x.tag_id
                where x.task_id = t.id and lower(g.name) = qq.tagname)
      else
        (t.search @@ qq.tsq) or t.title ilike qq.pat
        or exists (select 1 from task_tags x join tags g on g.id = x.tag_id
                   where x.task_id = t.id and g.name ilike qq.pat)
      end)
    union all
    select 'note', n.id, n.area_id, left(n.body, 300), n.body,
           null, null, null, n.updated_at,
           ((n.search @@ qq.tsq) and not qq.is_tag), ts_rank(n.search, qq.tsq),
           array(select g.name from note_tags x join tags g on g.id = x.tag_id
                 where x.note_id = n.id order by g.name)
    from notes n, qq
    where length(btrim(q)) >= 2 and (
      case when qq.is_tag then
        exists (select 1 from note_tags x join tags g on g.id = x.tag_id
                where x.note_id = n.id and lower(g.name) = qq.tagname)
      else
        (n.search @@ qq.tsq) or n.body ilike qq.pat
        or exists (select 1 from note_tags x join tags g on g.id = x.tag_id
                   where x.note_id = n.id and g.name ilike qq.pat)
      end)
    order by stem_match desc, rank desc, updated_at desc
    limit 100
  )
  select h.kind, h.id, h.area_id, h.head,
         case
           when h.stem_match then ts_headline('german', h.full_text, (select tsq from qq),
                'StartSel=«, StopSel=», MaxWords=22, MinWords=8, ShortWord=2, MaxFragments=1')
           else substr(h.full_text,
                greatest(position((select needle from qq) in lower(h.full_text)) - 40, 1), 140)
         end as snippet,
         h.status, h.due_date, h.priority, h.updated_at, h.stem_match, h.tags
  from hits h
  order by h.stem_match desc, h.rank desc, h.updated_at desc;
$$;

revoke execute on function search_all(text) from public, anon;
grant execute on function search_all(text) to authenticated;
