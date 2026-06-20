# DN Novi Sad Fork Customization — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Customize the NSRelaTech/dear-neighbors fork for Novi Sad — hardcode location, add Reddit r/novi_sad content with auto-translation.

**Architecture:** Config-level location lock (hide selectors, auto-set Novi Sad). Supabase Edge Function fetches Reddit JSON API daily, translates titles via Anthropic Haiku, upserts into existing `links` table. New `source` and translation columns. Reddit toggle in Settings UI.

**Tech Stack:** Preact + Signals (extension), Supabase Edge Functions (Deno), Anthropic API (translation), pg_cron (scheduling), Reddit public JSON API.

---

### Task 1: Database Migration — Add Source and Translation Columns

**Files:**
- Create: `api/migrations/014_add_source_and_translation.sql`

**Step 1: Write the migration SQL**

```sql
-- Add source column to links (null = user-submitted, 'reddit' = imported)
ALTER TABLE links ADD COLUMN source text;

-- Add translation columns
ALTER TABLE links ADD COLUMN title_translated text;
ALTER TABLE links ADD COLUMN description_translated text;

-- Index for filtering by source
CREATE INDEX idx_links_source ON links (source);

-- Drop and recreate links_with_votes to include new columns
DROP VIEW IF EXISTS links_with_votes;

CREATE OR REPLACE VIEW links_with_votes AS
SELECT
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
  coalesce(v.vote_count, 0) AS vote_count,
  coalesce(t.topic_ids, '{}') AS topic_ids,
  coalesce(t.topic_names, '{}') AS topic_names,
  coalesce(v.vote_count, 0)
    + (1.0 / (extract(epoch FROM now() - l.created_at) / 3600 + 2)) * 10 AS hot_score,
  exists(
    SELECT 1 FROM link_votes lv
    WHERE lv.link_id = l.id AND lv.user_id = auth.uid()
  ) AS user_voted
FROM links l
LEFT JOIN LATERAL (
  SELECT count(*) AS vote_count FROM link_votes WHERE link_id = l.id
) v ON true
LEFT JOIN LATERAL (
  SELECT
    array_agg(lt.topic_id) AS topic_ids,
    array_agg(tp.name) AS topic_names
  FROM link_topics lt
  JOIN topics tp ON tp.id = lt.topic_id
  WHERE lt.link_id = l.id
) t ON true;

-- Insert "r/novi_sad" topic
INSERT INTO topics (name, slug) VALUES ('r/novi_sad', 'r-novi-sad');

-- Allow service_role to insert links (for edge function) by adding RLS policy
CREATE POLICY "links_insert_service" ON links FOR INSERT
  WITH CHECK (submitted_by IS NULL AND source IS NOT NULL);

-- Allow service_role to insert link_topics for system-inserted links
CREATE POLICY "link_topics_insert_service" ON link_topics FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM links WHERE id = link_id AND source IS NOT NULL
    )
  );
```

**Step 2: Apply the migration**

Apply via Supabase MCP: `mcp__supabase__apply_migration` with project `eeidclmhfkndimghdyuq` and name `add_source_and_translation`.

**Step 3: Verify**

Run: `mcp__supabase__execute_sql` to confirm:
- `SELECT column_name FROM information_schema.columns WHERE table_name = 'links' AND column_name IN ('source', 'title_translated', 'description_translated');`
- `SELECT * FROM topics WHERE slug = 'r-novi-sad';`

**Step 4: Commit**

```bash
git add api/migrations/014_add_source_and_translation.sql
git commit -m "feat: add source and translation columns to links, r/novi_sad topic

Migration 014: adds source, title_translated, description_translated to links.
Recreates links_with_votes view. Adds r/novi_sad topic. Adds RLS policies
for service-role inserts (edge function).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Supabase Edge Function — sync-reddit

**Files:**
- Create: `api/functions/sync-reddit/index.ts`

**Step 1: Write the edge function**

The function:
1. Fetches `https://www.reddit.com/r/novi_sad/top.json?t=month&limit=25`
2. Looks up Novi Sad city ID and r/novi_sad topic ID from DB
3. For each post, checks if URL already exists in `links`
4. Inserts new posts with `source = 'reddit'`, `language = 'sr'`
5. Translates titles/descriptions to English via Anthropic Haiku
6. Links the r/novi_sad topic via `link_topics`

```typescript
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REDDIT_URL = "https://www.reddit.com/r/novi_sad/top.json?t=month&limit=25";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

Deno.serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Fetch Reddit posts
    const redditRes = await fetch(REDDIT_URL, {
      headers: { "User-Agent": "DearNeighbors/1.0 (Supabase Edge Function)" },
    });
    if (!redditRes.ok) {
      return new Response(
        JSON.stringify({ error: `Reddit API returned ${redditRes.status}` }),
        { status: 502 },
      );
    }
    const redditData = await redditRes.json();
    const posts = redditData?.data?.children ?? [];

    if (posts.length === 0) {
      return new Response(JSON.stringify({ synced: 0 }), { status: 200 });
    }

    // Look up Novi Sad city ID
    const { data: noviSad } = await supabase
      .from("neighborhoods")
      .select("id")
      .eq("name", "Novi Sad")
      .eq("type", "city")
      .single();

    if (!noviSad) {
      return new Response(
        JSON.stringify({ error: "Novi Sad not found in neighborhoods" }),
        { status: 500 },
      );
    }

    // Look up r/novi_sad topic ID
    const { data: redditTopic } = await supabase
      .from("topics")
      .select("id")
      .eq("slug", "r-novi-sad")
      .single();

    if (!redditTopic) {
      return new Response(
        JSON.stringify({ error: "r/novi_sad topic not found" }),
        { status: 500 },
      );
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    let synced = 0;

    for (const child of posts) {
      const post = child.data;
      if (!post || post.stickied) continue;

      const url = `https://www.reddit.com${post.permalink}`;
      const title = post.title?.trim();
      if (!title) continue;

      const description =
        post.selftext?.trim().slice(0, 500) || null;

      // Dedup check
      const { data: existing } = await supabase
        .from("links")
        .select("id")
        .eq("url", url)
        .maybeSingle();

      if (existing) continue;

      // Translate title (and description if present) to English
      let titleTranslated = null;
      let descriptionTranslated = null;

      if (anthropicKey) {
        try {
          const textsToTranslate = description
            ? `Title: ${title}\nDescription: ${description}`
            : `Title: ${title}`;

          const aiRes = await fetch(ANTHROPIC_API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 1024,
              messages: [
                {
                  role: "user",
                  content: `Translate the following from Serbian to English. Return ONLY the translation, preserving the "Title:" and "Description:" labels if present. If the text is already in English, return it unchanged.\n\n${textsToTranslate}`,
                },
              ],
            }),
          });

          if (aiRes.ok) {
            const aiData = await aiRes.json();
            const translated = aiData.content?.[0]?.text ?? "";
            const titleMatch = translated.match(/Title:\s*(.+?)(?:\n|$)/);
            const descMatch = translated.match(/Description:\s*(.+)/s);
            titleTranslated = titleMatch?.[1]?.trim() || null;
            descriptionTranslated = descMatch?.[1]?.trim() || null;
          }
        } catch (e) {
          console.error("Translation failed for:", title, e);
          // Continue without translation — not fatal
        }
      }

      // Insert link
      const { data: link, error: linkErr } = await supabase
        .from("links")
        .insert({
          url,
          title,
          title_translated: titleTranslated,
          description,
          description_translated: descriptionTranslated,
          neighborhood_id: noviSad.id,
          language: "sr",
          source: "reddit",
          submitted_by: null,
        })
        .select("id")
        .single();

      if (linkErr) {
        console.error("Failed to insert link:", url, linkErr);
        continue;
      }

      // Link topic
      await supabase.from("link_topics").insert({
        link_id: link.id,
        topic_id: redditTopic.id,
      });

      synced++;
    }

    return new Response(JSON.stringify({ synced, total: posts.length }), {
      status: 200,
    });
  } catch (err) {
    console.error("sync-reddit error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
    });
  }
});
```

**Step 2: Deploy the edge function**

Deploy via Supabase MCP: `mcp__supabase__deploy_edge_function` with project `eeidclmhfkndimghdyuq`, name `sync-reddit`, and the code above.

Then set the `ANTHROPIC_API_KEY` secret via Supabase dashboard or CLI.

**Step 3: Test manually**

Invoke the function via curl or Supabase dashboard to verify it fetches and inserts Reddit posts with translations.

**Step 4: Set up pg_cron schedule**

```sql
SELECT cron.schedule(
  'sync-reddit-daily',
  '0 6 * * *',
  $$SELECT net.http_post(
    url := 'https://eeidclmhfkndimghdyuq.supabase.co/functions/v1/sync-reddit',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    )
  );$$
);
```

Note: pg_cron + pg_net must be enabled in Supabase dashboard (Extensions). The service role key call may need adjustment based on Supabase's cron setup — may need to use a webhook or vault secret instead.

**Step 5: Commit**

```bash
git add api/functions/sync-reddit/index.ts
git commit -m "feat: add sync-reddit edge function with translation

Fetches r/novi_sad top monthly posts, inserts into links table,
translates titles to English via Anthropic Haiku. Runs daily via pg_cron.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Hardcode Novi Sad — Store + Onboarding

**Files:**
- Modify: `extension/src/store/neighborhoods.js` (loadNeighborhoods)
- Modify: `extension/src/components/OnboardingModal.jsx` (remove location step)
- Modify: `extension/src/lib/i18n.js` (update onboarding strings)

**Step 1: Auto-set Novi Sad in loadNeighborhoods**

In `extension/src/store/neighborhoods.js`, after `neighborhoods.value = data;` and the existing-user migration block, add auto-set logic:

```javascript
// NS fork: auto-set to Serbia > Novi Sad if no location configured
const savedCountry = localStorage.getItem('dn_country');
const savedCity = localStorage.getItem('dn_city');

if (!savedCountry || !savedCity) {
  const serbia = data.find((n) => n.name === 'Serbia' && n.type === 'country');
  const noviSad = data.find((n) => n.name === 'Novi Sad' && n.type === 'city');
  if (serbia && noviSad) {
    selectedCountryId.value = serbia.id;
    localStorage.setItem('dn_country', serbia.id);
    selectedCityId.value = noviSad.id;
    localStorage.setItem('dn_city', noviSad.id);
    activeNeighborhoodId.value = noviSad.id;
    localStorage.setItem('dn_neighborhood', noviSad.id);
  }
}
```

**Step 2: Simplify OnboardingModal — remove location step**

Replace the 3-step onboarding with 2 steps (Language + Account). Remove the country/city selectors entirely. The onboarding should start at step 1 = Language, step 2 = Account. Remove the progress dots for step 1 (location). The `citySelected` guard can be replaced with `locationConfigured` since it's now always true after loadNeighborhoods.

**Step 3: Update i18n strings**

Update `onboarding.subtitle` in both `en` and `sr`:
- en: `'Pick your language to get started'`
- sr: `'Izaberite jezik da započnete'`

**Step 4: Verify**

Build and load extension. New tab should skip location selection and show Language + Account steps only.

**Step 5: Commit**

```bash
git add extension/src/store/neighborhoods.js extension/src/components/OnboardingModal.jsx extension/src/lib/i18n.js
git commit -m "feat: hardcode Novi Sad — auto-set location, simplify onboarding

NS fork: auto-set Serbia > Novi Sad on first load. Remove country/city
selection from onboarding (now 2 steps: Language + Account).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Remove Location Selectors from Settings

**Files:**
- Modify: `extension/src/components/SettingsModal.jsx`

**Step 1: Remove country/city selectors, keep neighborhood selector**

In the Location section of SettingsModal, remove the country `<select>` and city `<select>`. Keep only the neighborhood list (Liman, Grbavica, etc.). The section title stays "Location" / "Lokacija" but only shows neighborhood picker.

Remove the conditional `{selectedCountryId.value && ...}` and `{selectedCityId.value && ...}` wrappers for the neighborhood list — it's always visible since location is always set.

Remove unused imports: `countries`, `citiesForCountry`, `setSelectedCountry`, `setSelectedCity`, `selectedCountryId`.

**Step 2: Verify**

Build and check Settings modal — should show neighborhood picker directly under "Location", no country/city dropdowns.

**Step 3: Commit**

```bash
git add extension/src/components/SettingsModal.jsx
git commit -m "feat: remove country/city selectors from Settings

NS fork: location is hardcoded to Novi Sad. Settings only shows
neighborhood picker (Liman, Grbavica, etc.).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Reddit Toggle in Store + Settings

**Files:**
- Create: `extension/src/store/reddit.js`
- Modify: `extension/src/store/links.js` (add source filter)
- Modify: `extension/src/components/SettingsModal.jsx` (add toggle)
- Modify: `extension/src/lib/i18n.js` (add strings)
- Modify: `extension/src/app.jsx` (pass showReddit to loadLinks)

**Step 1: Create reddit store**

```javascript
// extension/src/store/reddit.js
import { signal } from '@preact/signals';

export const showReddit = signal(
  localStorage.getItem('dn_show_reddit') !== 'false'
);

export function setShowReddit(val) {
  showReddit.value = val;
  localStorage.setItem('dn_show_reddit', String(val));
}
```

**Step 2: Add source filter to loadLinks**

In `extension/src/store/links.js`, add `excludeReddit` parameter to `loadLinks`:

```javascript
export async function loadLinks({ neighborhoodIds = [], topicIds = [], sort = 'hot', topRange, page = 1, append = false, language = null, excludeReddit = false }) {
```

After the language filter, add:

```javascript
if (excludeReddit) {
  query = query.or('source.is.null,source.neq.reddit');
}
```

**Step 3: Wire up in app.jsx**

Import `showReddit` from `'./store/reddit'` and pass `excludeReddit: !showReddit.value` to `loadLinks`. Add `showReddit.value` to the useEffect dependency array.

**Step 4: Wire up in LinksFeed.jsx**

Import `showReddit` from `'../store/reddit'` and add `excludeReddit: !showReddit.value` to `reloadOpts()`.

**Step 5: Add toggle to SettingsModal**

After the Topics section, add a Reddit toggle section:

```jsx
<section class="settings-section">
  <label class="settings-toggle-row">
    <span class="settings-toggle-label">{t('settings.reddit')}</span>
    <label class="settings-toggle-switch">
      <input
        type="checkbox"
        checked={showReddit.value}
        onChange={(e) => setShowReddit(e.target.checked)}
      />
      <span class="settings-toggle-track" />
    </label>
  </label>
  <p class="settings-hint">{t('settings.redditHint')}</p>
</section>
```

**Step 6: Add i18n strings**

```javascript
// en
'settings.reddit': 'Reddit r/novi_sad',
'settings.redditHint': 'Show top posts from the r/novi_sad subreddit in your feed.',

// sr
'settings.reddit': 'Reddit r/novi_sad',
'settings.redditHint': 'Prikaži popularne objave sa r/novi_sad u tvom fidu.',
```

**Step 7: Commit**

```bash
git add extension/src/store/reddit.js extension/src/store/links.js extension/src/components/SettingsModal.jsx extension/src/lib/i18n.js extension/src/app.jsx extension/src/components/LinksFeed.jsx
git commit -m "feat: add Reddit toggle — show/hide r/novi_sad posts

New showReddit signal persisted to localStorage. Toggle in Settings.
When off, excludes source='reddit' from link queries.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Reddit Source Badge + Translation Display in LinksFeed

**Files:**
- Modify: `extension/src/components/LinksFeed.jsx` (LinkCard)
- Modify: `extension/src/styles/links.css` (badge styles)
- Modify: `extension/src/lib/i18n.js` (if needed)

**Step 1: Show translated title/description based on uiLanguage**

In `LinkCard`, determine which title/description to display:

```javascript
function LinkCard({ link, onVote, onDelete }) {
  const lang = uiLanguage.value;
  const showTranslated = link.source === 'reddit' && lang !== link.language;
  const displayTitle = (showTranslated && link.title_translated) || link.title;
  const displayDescription = (showTranslated && link.description_translated) || link.description;
  // ... rest uses displayTitle and displayDescription
```

Import `uiLanguage` from `'../lib/i18n'`.

**Step 2: Add source badge for Reddit posts**

In the `link-meta` div, after the time span, add:

```jsx
{link.source === 'reddit' && (
  <span class="link-source-badge link-source-reddit">r/novi_sad</span>
)}
```

**Step 3: Add CSS for the badge**

In `extension/src/styles/links.css`, add:

```css
.link-source-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.link-source-reddit {
  background: #ff4500;
  color: #fff;
}
```

**Step 4: Invoke frontend-design skill**

Before finalizing the badge styling, invoke the `frontend-design` skill to ensure the badge looks polished and consistent with existing DN styles (topic tags, session source badges).

**Step 5: Verify**

Build and check that Reddit posts show the "r/novi_sad" badge and display translated titles when the UI language differs from the link language.

**Step 6: Commit**

```bash
git add extension/src/components/LinksFeed.jsx extension/src/styles/links.css
git commit -m "feat: Reddit source badge + translated title display

Reddit posts show 'r/novi_sad' badge. Titles/descriptions display in
user's language when translation is available.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Build, Test End-to-End, Push

**Step 1: Build the extension**

```bash
cd extension && npm run build
```

**Step 2: Load in Chrome and test**

- Fresh install (clear localStorage): should auto-set Novi Sad, show 2-step onboarding
- Settings: no country/city dropdowns, neighborhood picker works, Reddit toggle visible
- Links feed: Reddit posts visible with badge, translated titles in English when UI=en
- Toggle Reddit off: Reddit posts disappear from feed
- Vote on a Reddit post: works like any other link

**Step 3: Push to both remotes**

```bash
git push origin master
git push nsrelatech master
```

**Step 4: Verify fork is synced**

Use GitHub MCP to compare latest commits on both repos.
