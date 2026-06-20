-- Migration 014: add source + translation columns to links, r/novi_sad topic
-- NS fork: supports Reddit-imported links (source='reddit') with auto-translated
-- title/description for the r/novi_sad sync edge function.

-- Add source column to links (null = user-submitted, 'reddit' = imported)
alter table links add column if not exists source text;

-- Add translation columns
alter table links add column if not exists title_translated text;
alter table links add column if not exists description_translated text;

-- Index for filtering by source
create index if not exists idx_links_source on links (source);

-- Drop and recreate links_with_votes to include new columns
drop view if exists links_with_votes;

create view links_with_votes as
select
  l.id,
  l.url,
  l.title,
  l.title_translated,
  l.description,
  l.description_translated,
  l.submitted_by,
  l.neighborhood_id,
  l.language,
  l.source,
  l.created_at,
  coalesce(v.vote_count, 0) as vote_count,
  coalesce(t.topic_ids, '{}') as topic_ids,
  coalesce(t.topic_names, '{}') as topic_names,
  coalesce(v.vote_count, 0)
    + (1.0 / (extract(epoch from now() - l.created_at) / 3600 + 2)) * 10 as hot_score,
  exists(
    select 1 from link_votes lv
    where lv.link_id = l.id and lv.user_id = auth.uid()
  ) as user_voted
from links l
left join lateral (
  select count(*) as vote_count from link_votes where link_id = l.id
) v on true
left join lateral (
  select
    array_agg(lt.topic_id) as topic_ids,
    array_agg(tp.name) as topic_names
  from link_topics lt
  join topics tp on tp.id = lt.topic_id
  where lt.link_id = l.id
) t on true;

-- Insert "r/novi_sad" topic (idempotent)
insert into topics (name, slug) values ('r/novi_sad', 'r-novi-sad')
on conflict (slug) do nothing;

-- No INSERT policy is needed for the sync-reddit edge function: it uses the
-- service_role key, which bypasses RLS entirely. (Earlier drafts added public
-- INSERT policies here; dropped — they were unnecessary and, lacking a TO clause,
-- would have let any client insert null-attributed, source-tagged links.)
