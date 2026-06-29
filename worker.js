// worker.js
// Single Worker handling:
//   /projects              -- portfolio CRUD (unchanged from original)
//   /auth/linkedin/login    -- redirect to LinkedIn OAuth
//   /auth/linkedin/callback -- OAuth callback, stores token in D1
//   /api/linkedin-status    -- connection status for the scheduler UI
//   /api/generate-post      -- on-demand Groq draft generation
//   /api/auto-generate      -- autonomous daily draft + review email (cron-triggered)
//   /api/posts              -- CRUD for scheduled_posts
//   /api/publish-due        -- publishes due posts to LinkedIn (cron-triggered)
//   /api/cancel-post        -- one-click cancel link target (from review email)
//
// Cron Triggers for this Worker (set in wrangler.jsonc):
//   */5 * * * *   -> publish-due check
//   15 2 * * *    -> daily auto-generate (08:00 Kathmandu time)

const LINKEDIN_API_VERSION = '202506';
const AUTO_GENERATE_CRON = '15 10 * * *';

const ANGLES = [
  {
    key: 'product_update',
    brief: 'Share a product or progress update about Inferreach -- something the team shipped, improved, or learned recently. Keep it concrete and specific, not generic "we are excited to announce" filler.',
  },
  {
    key: 'industry_take',
    brief: 'Share a confident, specific opinion or observation about a trend in IT services/consulting or software development that connects naturally to what Inferreach does. Avoid generic AI hype.',
  },
  {
    key: 'behind_the_scenes',
    brief: 'Share a behind-the-scenes moment from building Inferreach -- a lesson learned, a mistake fixed, a small decision that mattered. Founder-voice, not corporate.',
  },
  {
    key: 'client_value',
    brief: "Talk about the kind of problem Inferreach solves for clients and why it matters, without naming a specific real client unless one is provided. Frame it around the client's pain point, not a sales pitch.",
  },
];

const POST_SYSTEM_PROMPT = `You write LinkedIn posts for Prajwol, founder of Inferreach (inferreach.com), an IT services & consulting company.

GOAL: grow followers, get profile visits, and attract founders/business decision-makers who might hire Inferreach. Every post should make a stranger think "I should follow this person" or "I should talk to this company."

AUDIENCE: founders, CEOs, and business decision-makers evaluating whether to bring in outside IT/dev help. Write to THEM, not to other developers.

WHAT MAKES LINKEDIN POSTS PERFORM IN 2026 (the algorithm has shifted -- follow these strictly):
1. HOOK (line 1-2, before "see more" truncates it): a specific claim, a number, a contrarian take, or a recognizable problem stated plainly. This single line decides if anyone reads further. Never start with "I'm excited to..." or "In today's world...".
2. STRUCTURE: short lines, one idea per line, generous white space. A wall of paragraph text gets scrolled past. Occasionally a single short line for emphasis/pacing.
3. SPECIFICITY OVER ABSTRACTION: a concrete scenario beats a generic claim. If no real specifics were given, invent a plausible, realistic, GENERIC scenario -- never fabricate specific client names, real numbers, or claims of "we did X for client Y."
4. NO DEAD CORPORATE LANGUAGE: avoid "leverage," "synergy," "passionate," "thrilled to announce," "game-changer," "circle back." Write like a sharp, plainspoken founder talking to a peer.
5. DEPTH OVER CHEAP ENGAGEMENT: LinkedIn's 2026 algorithm actively detects and suppresses engagement bait ("Comment YES if you agree," "Tag someone who needs this," forced reaction polling). Never use these tactics. Instead end with one genuine, specific question that a real reader would want to answer in a comment -- this builds real "Depth Score" (dwell time + comment quality), which is what actually drives distribution now.
6. NO LINKS IN THE POST BODY: posts with outbound links lose roughly 60% of their reach under the 2026 algorithm. Never include inferreach.com or any URL in the post text. The call-to-action is the question, not a link.
7. HASHTAGS: exactly 3 to 5 at the very end, on their own line. More than 5 triggers spam/low-quality filtering and REDUCES reach -- never exceed 5, and 10+ actively hurts. Mix one broader industry tag (e.g. #ITConsulting) with 2-3 more specific, niche tags tied to the post's actual topic (e.g. #StartupInfrastructure, #TechDebt, #FounderLessons) rather than generic tags everyone uses. Use PascalCase (#SoftwareDevelopment, not #softwaredevelopment).
8. LENGTH: 800-1200 characters. Long enough to deliver one real idea, short enough to read in 20 seconds.
9. TONE: professional, confident, a little opinionated -- but not personal/vulnerable. No oversharing. Stay in business-credibility territory, not diary-entry territory.
10. Max 1 emoji, often zero.

Output ONLY the post text, hashtags included at the end. No preamble, no quotation marks around it, no "Here's a post:" framing.`;
// ---------- small helpers ----------

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

function html(body, status) {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:60px auto;text-align:center">${body}</body></html>`,
    { status: status || 200, headers: { 'Content-Type': 'text/html' } }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function checkAdmin(request, env) {
  const provided = request.headers.get('x-admin-password') || '';
  return Boolean(provided) && provided === env.ADMIN_PASSWORD;
}

function checkCron(request, env) {
  const provided = request.headers.get('x-cron-secret') || '';
  return Boolean(provided) && provided === env.CRON_SECRET;
}

// ---------- LinkedIn OAuth ----------

async function handleLinkedinLogin(request, env) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/linkedin/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email w_member_social',
    state: crypto.randomUUID(),
  });
  return Response.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`, 302);
}

async function handleLinkedinCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) return html(`<h2>LinkedIn authorization failed</h2><p>${escapeHtml(error)}</p>`, 400);
  if (!code) return html('<h2>Missing authorization code</h2>', 400);

  const redirectUri = `${url.origin}/auth/linkedin/callback`;

  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.LINKEDIN_CLIENT_ID,
      client_secret: env.LINKEDIN_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) return html(`<h2>Token exchange failed</h2><pre>${escapeHtml(await tokenRes.text())}</pre>`, 400);

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  const userRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) return html(`<h2>Failed to fetch LinkedIn identity</h2><pre>${escapeHtml(await userRes.text())}</pre>`, 400);

  const userData = await userRes.json();
  const personUrn = `urn:li:person:${userData.sub}`;
  const name = userData.name || '';

  await env.DB.prepare(
    `INSERT INTO linkedin_auth (id, access_token, person_urn, expires_at, name, connected_at)
     VALUES (1, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       person_urn = excluded.person_urn,
       expires_at = excluded.expires_at,
       name = excluded.name,
       connected_at = datetime('now')`
  ).bind(accessToken, personUrn, expiresAt, name).run();

  return html(
    `<h2>✅ LinkedIn connected</h2><p>Connected as <strong>${escapeHtml(name)}</strong>. Token valid until ${expiresAt}.</p><p><a href="/scheduler.html">Go to scheduler →</a></p>`
  );
}

async function handleLinkedinStatus(request, env) {
  if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const auth = await env.DB.prepare('SELECT name, expires_at, connected_at FROM linkedin_auth WHERE id = 1').first();
  if (!auth) return json({ connected: false });
  const expired = new Date(auth.expires_at) < new Date();
  return json({ connected: !expired, expired, name: auth.name, expires_at: auth.expires_at, connected_at: auth.connected_at });
}

// ---------- Groq ----------

async function generateWithGroq(systemPrompt, userPrompt, env) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`Groq request failed: ${await res.text()}`);
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message.content.trim()) || '';
}

async function handleGeneratePost(request, env) {
  if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const { topic } = await request.json();
  if (!topic || !topic.trim()) return json({ error: 'topic is required' }, 400);
  try {
    const content = await generateWithGroq(POST_SYSTEM_PROMPT, `Write a LinkedIn post about: ${topic}`, env);
    return json({ content });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

// ---------- scheduled_posts CRUD ----------

async function handlePostsGet(request, env) {
  if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const { results } = await env.DB.prepare('SELECT * FROM scheduled_posts ORDER BY scheduled_for DESC').all();
  return json(results);
}

async function handlePostsCreate(request, env) {
  if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const p = await request.json();
  if (!p.content || !p.scheduled_for) return json({ error: 'content and scheduled_for are required' }, 400);
  const id = Date.now();
  await env.DB.prepare(
    `INSERT INTO scheduled_posts (id, content, scheduled_for, status, generated_by_groq, topic_prompt, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'))`
  ).bind(id, p.content, p.scheduled_for, p.generated_by_groq ? 1 : 0, p.topic_prompt || null).run();
  return json({ success: true, id });
}

async function handlePostsDelete(request, env) {
  if (!checkAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  await env.DB.prepare(
    "UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'awaiting_review')"
  ).bind(id).run();
  return json({ success: true });
}

// ---------- publish-due ----------

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
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });

  if (res.ok || res.status === 201) {
    const postUrn = res.headers.get('x-restli-id') || null;
    await env.DB.prepare(
      "UPDATE scheduled_posts SET status = 'sent', sent_at = datetime('now'), linkedin_post_urn = ? WHERE id = ?"
    ).bind(postUrn, post.id).run();
    return { id: post.id, ok: true, postUrn };
  } else {
    const errText = await res.text();
    await env.DB.prepare("UPDATE scheduled_posts SET status = 'failed', error_message = ? WHERE id = ?")
      .bind(errText.slice(0, 500), post.id).run();
    return { id: post.id, ok: false, error: errText };
  }
}

async function runPublishDue(env) {
  const auth = await env.DB.prepare('SELECT * FROM linkedin_auth WHERE id = 1').first();
  if (!auth) return { error: 'LinkedIn not connected', results: [] };
  if (new Date(auth.expires_at) < new Date()) {
    return { error: 'LinkedIn token expired -- reconnect via /auth/linkedin/login', results: [] };
  }

  const now = new Date().toISOString();
  const { results: due } = await env.DB.prepare(
    `SELECT * FROM scheduled_posts
     WHERE status IN ('pending', 'awaiting_review') AND scheduled_for <= ?
     ORDER BY scheduled_for ASC`
  ).bind(now).all();

  const outcomes = [];
  for (const post of due) {
    outcomes.push(await publishOne(post, auth, env));
  }
  return { checked: due.length, results: outcomes };
}

async function handlePublishDue(request, env) {
  if (!checkCron(request, env)) return json({ error: 'Unauthorized' }, 401);
  const result = await runPublishDue(env);
  return json(result);
}

// ---------- auto-generate ----------

async function nextAngle(env) {
  const row = await env.DB.prepare('SELECT last_index FROM angle_rotation WHERE id = 1').first();
  const lastIndex = row ? row.last_index : -1;
  const nextIndex = (lastIndex + 1) % ANGLES.length;
  await env.DB.prepare('UPDATE angle_rotation SET last_index = ? WHERE id = 1').bind(nextIndex).run();
  return ANGLES[nextIndex];
}

async function sendReviewEmail({ content, angle, cancelUrl, reviewUrl }, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Inferreach Scheduler <scheduler@inferreach.com>',
      to: env.NOTIFY_EMAIL,
      subject: `LinkedIn post drafted (${angle.key}) -- publishes in 30 min unless cancelled`,
      html: `
        <div style="font-family:sans-serif;max-width:560px">
          <p>Groq drafted today's LinkedIn post (angle: <strong>${angle.key}</strong>). It will publish automatically in <strong>30 minutes</strong> unless you cancel it.</p>
          <div style="background:#f5f5f0;border:1px solid #ddd;border-radius:8px;padding:16px;white-space:pre-wrap;margin:16px 0">${escapeHtml(content)}</div>
          <p>
            <a href="${cancelUrl}" style="display:inline-block;background:#a4392f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Cancel this post</a>
            &nbsp;
            <a href="${reviewUrl}" style="display:inline-block;background:#1a1916;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review in scheduler</a>
          </p>
        </div>
      `,
    }),
  });
  if (!res.ok) console.error('Resend email failed:', await res.text());
}

async function runAutoGenerate(request, env) {
  const angle = await nextAngle(env);
  let content;
  try {
    content = await generateWithGroq(POST_SYSTEM_PROMPT, angle.brief, env);
  } catch (e) {
    return { error: e.message };
  }

  const id = Date.now();
  const cancelToken = crypto.randomUUID();
  const publishAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO scheduled_posts (id, content, scheduled_for, status, generated_by_groq, auto_generated, angle, cancel_token, created_at)
     VALUES (?, ?, ?, 'awaiting_review', 1, 1, ?, ?, datetime('now'))`
  ).bind(id, content, publishAt, angle.key, cancelToken).run();

  const origin = new URL(request.url).origin;
  const cancelUrl = `${origin}/api/cancel-post?id=${id}&token=${cancelToken}`;
  const reviewUrl = `${origin}/scheduler.html`;

  await sendReviewEmail({ content, angle, cancelUrl, reviewUrl }, env);

  return { success: true, id, angle: angle.key, publishAt };
}

async function handleAutoGenerate(request, env) {
  if (!checkCron(request, env)) return json({ error: 'Unauthorized' }, 401);
  const result = await runAutoGenerate(request, env);
  return json(result, result.error ? 502 : 200);
}

// ---------- cancel-post ----------

async function handleCancelPost(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!id || !token) return html('<h2>Missing id or token</h2>', 400);

  const post = await env.DB.prepare('SELECT * FROM scheduled_posts WHERE id = ?').bind(id).first();
  if (!post) return html('<h2>Post not found</h2>', 404);
  if (post.cancel_token !== token) return html('<h2>Invalid cancel link</h2>', 403);
  if (post.status !== 'awaiting_review' && post.status !== 'pending') {
    return html(`<h2>Already ${escapeHtml(post.status)}</h2><p>This post can't be cancelled now.</p>`);
  }

  await env.DB.prepare("UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ?").bind(id).run();
  return html('<h2>✅ Cancelled</h2><p>This post will not be published.</p>');
}

// ---------- original portfolio /projects handler (unchanged) ----------

async function handleProjects(request, env, corsHeaders) {
  const headers = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    return new Response(JSON.stringify(results), { headers });
  }
  if (request.method === 'POST') {
    const p = await request.json();
    await env.DB.prepare('INSERT INTO projects (id,title,cat,description,tags,year,img,live,gh) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(p.id, p.title, p.cat, p.description, p.tags, p.year, p.img, p.live, p.gh).run();
    return new Response(JSON.stringify(p), { headers });
  }
  if (request.method === 'PATCH') {
    const p = await request.json();
    await env.DB.prepare('UPDATE projects SET title=?,cat=?,description=?,tags=?,year=?,img=?,live=?,gh=? WHERE id=?')
      .bind(p.title, p.cat, p.description, p.tags, p.year, p.img, p.live, p.gh, p.id).run();
    return new Response(JSON.stringify(p), { headers });
  }
  if (request.method === 'DELETE') {
    const p = await request.json();
    if (p.id === 'all') await env.DB.prepare('DELETE FROM projects').run();
    else await env.DB.prepare('DELETE FROM projects WHERE id=?').bind(p.id).run();
    return new Response('{}', { headers });
  }
  return new Response('Method not allowed', { status: 405, headers });
}

// ---------- main router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-password, x-cron-secret',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // --- existing portfolio route, untouched ---
    if (url.pathname === '/projects') {
      return handleProjects(request, env, corsHeaders);
    }

    // --- LinkedIn scheduler routes ---
    if (url.pathname === '/auth/linkedin/login' && request.method === 'GET') {
      return handleLinkedinLogin(request, env);
    }
    if (url.pathname === '/auth/linkedin/callback' && request.method === 'GET') {
      return handleLinkedinCallback(request, env);
    }
    if (url.pathname === '/api/linkedin-status' && request.method === 'GET') {
      return handleLinkedinStatus(request, env);
    }
    if (url.pathname === '/api/generate-post' && request.method === 'POST') {
      return handleGeneratePost(request, env);
    }
    if (url.pathname === '/api/posts' && request.method === 'GET') {
      return handlePostsGet(request, env);
    }
    if (url.pathname === '/api/posts' && request.method === 'POST') {
      return handlePostsCreate(request, env);
    }
    if (url.pathname === '/api/posts' && request.method === 'DELETE') {
      return handlePostsDelete(request, env);
    }
    if (url.pathname === '/api/publish-due' && request.method === 'POST') {
      return handlePublishDue(request, env);
    }
    if (url.pathname === '/api/auto-generate' && request.method === 'POST') {
      return handleAutoGenerate(request, env);
    }
    if (url.pathname === '/api/cancel-post' && request.method === 'GET') {
      return handleCancelPost(request, env);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  // Cron Trigger entrypoint -- this Worker has crons defined in wrangler.jsonc
  async scheduled(event, env, ctx) {
    if (event.cron === AUTO_GENERATE_CRON) {
      // auto-generate needs a "request" only for url.origin; build a fake one from env
      const fakeRequest = new Request('https://prajwolraj.com.np/api/auto-generate');
      const result = await runAutoGenerate(fakeRequest, env);
      console.log('auto-generate (cron):', JSON.stringify(result));
    } else {
      const result = await runPublishDue(env);
      console.log('publish-due (cron):', JSON.stringify(result));
    }
  },
};