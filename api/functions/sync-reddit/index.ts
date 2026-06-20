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
