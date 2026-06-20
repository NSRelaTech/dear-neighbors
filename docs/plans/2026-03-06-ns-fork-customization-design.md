# DN Novi Sad Fork Customization

Date: 2026-03-06
Branch: NSRelaTech/dear-neighbors (fork of Citizen-Infra/dear-neighbors)

## Goal

Customize the Dear Neighbors extension for Novi Sad residents:
1. Remove city selection — hardcode to Novi Sad
2. Auto-populate content from Reddit r/novi_sad top monthly posts

## Design Decisions

- Reddit posts mixed into the existing links feed (not a separate section)
- Reddit posts are voteable within DN (inserted into `links` table)
- Fetched via Supabase Edge Function on a daily schedule (pg_cron)
- Reddit's public JSON API — no auth, no scraping, no Firecrawl
- Store Reddit permalink (discussion thread), not external URLs
- Location hardcoded at config level (keep DB/store intact, hide selectors)
- Reddit toggle separate from topic chips (on/off switch in Settings)

## 1. Hardcode Novi Sad (config lock)

- On first load (no `dn_country`/`dn_city` in localStorage), auto-set to Serbia > Novi Sad
- Remove country/city selectors from OnboardingModal and SettingsModal
- Keep neighborhood selector (Liman, Grbavica, etc.) in Settings
- Onboarding simplifies to 2 steps: Language > Account
- `loadNeighborhoods()` still fetches full tree from DB, location is pre-set

## 2. Reddit Content Pipeline

### Edge Function: `sync-reddit`

- Fetches `https://www.reddit.com/r/novi_sad/top.json?t=month&limit=25`
- Requires `User-Agent` header (Reddit blocks bare requests)
- Parses JSON: each `data.children[].data` has `title`, `permalink`, `selftext`, `score`
- For each post, upserts into `links` table:
  - `url` = `https://www.reddit.com` + `data.permalink`
  - `title` = `data.title`
  - `description` = `data.selftext` (truncated to 500 chars) or null
  - `neighborhood_id` = Novi Sad city ID (from `neighborhoods` table)
  - `language` = `'sr'`
  - `submitted_by` = null (system-inserted, no auth user)
  - `source` = `'reddit'` (new column)
- Dedup: skip if URL already exists in `links`
- After insert, link the "Reddit" topic via `link_topics`
- Translate each title (and description if present) from Serbian to English using
  Anthropic API (Claude Haiku). Store in `title_translated` / `description_translated`.

### Schema Changes

- `links` table: add column `source` (text, nullable, default null)
  - `null` = user-submitted
  - `'reddit'` = imported from Reddit
- `links` table: add columns `title_translated` (text, nullable),
  `description_translated` (text, nullable)
- `topics` table: insert new topic row "r/novi_sad"
- `links_with_votes` view: recreate to include `source`, `title_translated`,
  `description_translated`

### Schedule

- `pg_cron` job: daily (e.g., 06:00 UTC)
- Invokes the edge function via HTTP

## 3. Reddit Toggle in UI

- New signal `showReddit` in store (persisted to localStorage `dn_show_reddit`, default: true)
- SettingsModal: separate toggle switch for Reddit content, below topic chips
- When off: `loadLinks()` adds `.neq('source', 'reddit')` to query
- When on: no filter, Reddit posts appear alongside user-submitted links

## 4. Feed Display

- Reddit posts appear in LinksFeed with a small "r/novi_sad" source badge
- Badge styled similarly to participation card source badges
- Voteable with DN's own upvote/unvote system
- Reddit's original score not displayed

## 5. Manifest

No changes needed — extension doesn't call Reddit directly (edge function does).

## 6. Auto-Translation

Novi Sad has both Serbian residents and expats/digital nomads. All content should be
readable in the user's selected language so everyone aligns on the same local issues.

### How it works

- The `sync-reddit` edge function translates each Reddit post title (and description
  if present) from Serbian to English using the Anthropic API (Claude Haiku — cheap,
  fast, good enough for short titles).
- Two new columns on `links`: `title_translated` (text, nullable), `description_translated`
  (text, nullable). Original content stays in `title`/`description`.
- For Reddit posts (`source = 'reddit'`): `title` = original Serbian,
  `title_translated` = English translation.
- The UI checks `uiLanguage`: if it matches the link's `language` field, show original.
  If different, show translated version (falling back to original if no translation).
- Future: user-submitted links could also get auto-translated on insert (out of scope
  for this phase, but the schema supports it).

### Why edge function, not client-side

- Translation happens once at sync time, not on every page load.
- No API key exposed in the extension.
- Consistent translations — everyone sees the same text.

## Out of Scope

- Reddit comment display
- Reddit flair-to-topic mapping
- Reddit auth/login
- PopupForm changes
- Changes to upstream Citizen-Infra repo
- Auto-translation of user-submitted links (schema ready, implementation later)
