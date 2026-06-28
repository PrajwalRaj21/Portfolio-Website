// /functions/api/publish-due.js
// Checks for scheduled_posts that are due, publishes them to LinkedIn via
// POST /rest/posts, and updates their status. Triggered by a Cron Trigger
// (see scheduled() handler), but also reachable manually with a shared secret
// header for testing.

const LINKEDIN_API_VERSION = '202506'; // YYYYMM format, bump periodically

async function publishOne(post, auth, env) {
  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
    },
    body: JSON.stringify({
      author: auth.person_urn,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });

  if (res.ok || res.status === 201) {
    const postUrn = res.headers.get('x-restli-id') || null;
    await env.DB.prepare(
      `UPDATE scheduled_posts SET status = 'sent', sent_at = datetime('now'), linkedin_post_urn = ? WHERE id = ?`
    )
      .bind(postUrn, post.id)
      .run();
    return { id: post.id, ok: true, postUrn };
  } else {
    const errText = await res.text();
    await env.DB.prepare(
      `UPDATE scheduled_posts SET status = 'failed', error_message = ? WHERE id = ?`
    )
      .bind(errText.slice(0, 500), post.id)
      .run();
    return { id: post.id, ok: false, error: errText };
  }
}

async function runPublishDue(env) {
  const auth = await env.DB.prepare('SELECT * FROM linkedin_auth WHERE id = 1').first();
  if (!auth) {
    return { error: 'LinkedIn not connected', results: [] };
  }
  if (new Date(auth.expires_at) < new Date()) {
    return { error: 'LinkedIn token expired — reconnect via /auth/linkedin/login', results: [] };
  }

  const now = new Date().toISOString();
  const { results: due } = await env.DB.prepare(
    `SELECT * FROM scheduled_posts
     WHERE status IN ('pending', 'awaiting_review') AND scheduled_for <= ?
     ORDER BY scheduled_for ASC`
  )
    .bind(now)
    .all();

  const outcomes = [];
  for (const post of due) {
    outcomes.push(await publishOne(post, auth, env));
  }
  return { checked: due.length, results: outcomes };
}

// Manual/HTTP trigger — protected by a shared secret header (not the admin password,
// since this is meant to be hit by automation, not a human typing a password).
export async function onRequestPost(context) {
  const { request, env } = context;
  const provided = request.headers.get('x-cron-secret') || '';
  if (!provided || provided !== env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  const result = await runPublishDue(env);
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
}

// NOTE: Cloudflare Pages Functions do NOT support Cron Triggers / scheduled()
// handlers — only standalone Workers do. The actual timer lives in a small
// separate Worker (see cron-worker/index.js) which calls this endpoint over
// HTTP using the shared CRON_SECRET header below, on a schedule.
