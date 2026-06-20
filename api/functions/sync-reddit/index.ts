import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Reddit blocks unauthenticated .json requests from datacenter IPs (Supabase
// edge runs on such IPs), so we use app-only OAuth (client_credentials grant)
// against oauth.reddit.com. Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET
// secrets (register a "script" app at https://www.reddit.com/prefs/apps).
const REDDIT_OAUTH_URL =
  "https://oauth.reddit.com/r/novi_sad/top?t=month&limit=25";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const USER_AGENT = "web:dear-neighbors:v0.1.9 (Citizen Infra / NSRelaTech)";

async function getRedditToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(
      `Reddit token endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("Reddit token response had no access_token");
  return data.access_token;
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const clientId = Deno.env.get("REDDIT_CLIENT_ID");
    const clientSecret = Deno.env.get("REDDIT_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({
          error:
            "Missing REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET secrets. Register a script app at reddit.com/prefs/apps and add both as Supabase Edge Function secrets.",
        }),
        { status: 500 },
      );
    }

    // App-only OAuth token, then fetch the subreddit's top monthly posts.
    const token = await getRedditToken(clientId, clientSecret);
    const redditRes = await fetch(REDDIT_OAUTH_URL, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
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
