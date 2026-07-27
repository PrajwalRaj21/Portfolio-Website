// worker.js
// Single Worker handling:
//   /projects              -- portfolio CRUD (unchanged from original)
//   /auth/linkedin/login    -- redirect to LinkedIn OAuth
//   /auth/linkedin/callback -- OAuth callback, stores token in D1
//   /api/linkedin-status    -- connection status for the scheduler UI
//   /api/generate-post      -- on-demand Groq draft generation
//   /api/auto-generate      -- autonomous draft + review email (cron-triggered, gated to every-other-day + random time)
//   /api/posts              -- CRUD for scheduled_posts
//   /api/publish-due        -- publishes due posts to LinkedIn (cron-triggered)
//   /api/cancel-post        -- one-click cancel link target (from review email)
//
// Cron Triggers for this Worker (set in wrangler.jsonc):
//   */5 * * * *      -> publish-due check (every 5 min, all day)
//   */10 10-11 * * * -> auto-generate window check (every 10 min, 10:15-11:15 UTC == 16:00-17:00 Kathmandu time)
//
// SCHEDULING LOGIC (every-other-day, random time 4-5pm Kathmandu):
//   D1 table `auto_post_schedule` (id=1) tracks:
//     last_post_date  -- the date (YYYY-MM-DD, Kathmandu-local) a post was last auto-generated
//     next_run_at     -- the randomly chosen ISO timestamp within today's 4-5pm window, once picked
//   On each cron tick inside the window:
//     1. Skip if last_post_date was yesterday or today (i.e. not yet 2 days since last post).
//     2. If eligible and next_run_at isn't set for today yet, pick a random time in the
//        remaining window and store it (don't post yet).
//     3. If eligible and now >= next_run_at, generate + send review email, and record today
//        as last_post_date.

const LINKEDIN_API_VERSION = '202506';

// Kathmandu is UTC+5:45. The 4:00-5:00pm (16:00-17:00) local window is 10:15-11:15 UTC.
const WINDOW_START_UTC_MINUTES = 10 * 60 + 15; // 10:15 UTC
const WINDOW_END_UTC_MINUTES = 11 * 60 + 15;   // 11:15 UTC
const KATHMANDU_OFFSET_MINUTES = 5 * 60 + 45;

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
  {
    key: 'technical_deep_dive',
    brief: 'Explain one specific technical concept relevant to data engineering or IT infrastructure (e.g. pipeline monitoring, data quality checks, orchestration tradeoffs) in a way a non-technical founder could still follow. Show expertise without jargon-dumping.',
  },
  {
    key: 'mistake_or_failure',
    brief: 'Describe a real or plausible mistake, wrong assumption, or failed approach in building software/data systems, and what it taught you. Vulnerability builds trust -- but stay in professional territory, not personal oversharing.',
  },
  {
    key: 'contrarian_take',
    brief: 'Challenge a common assumption or piece of "conventional wisdom" in software development, IT consulting, or startup tooling. Be specific about what people get wrong and why. Should spark disagreement or debate in the comments.',
  },
  {
    key: 'cost_or_roi',
    brief: 'Talk about the real cost of a common IT/data problem (downtime, bad data, technical debt, slow reporting) in terms a business decision-maker cares about -- time, money, missed opportunities. Avoid inventing specific numbers; use realistic ranges or scenarios instead.',
  },
  {
    key: 'process_or_workflow',
    brief: 'Walk through how Inferreach approaches a specific type of project or problem (e.g. auditing a client\'s existing pipeline, onboarding a new data source, diagnosing a broken dashboard) as a mini case-study-style narrative, without naming a real client.',
  },
  {
    key: 'trend_prediction',
    brief: 'Make a specific, falsifiable prediction about where IT services, data infrastructure, or small-business tech adoption is headed in the next 1-2 years. Ground it in something observable now, not vague futurism.',
  },
  {
    key: 'hiring_or_team',
    brief: 'Share a perspective on what makes a good data engineer, IT consultant, or technical hire -- or a lesson about building/running a small technical team. Keep it grounded in practical experience, not generic leadership platitudes.',
  },
  {
    key: 'tool_or_stack_opinion',
    brief: 'Share a specific, opinionated take on a tool, platform, or approach commonly used in data engineering or IT infrastructure (e.g. when NOT to use a certain orchestrator, why a "boring" tool beats a trendy one for most companies). Should read as earned expertise, not a sponsored post.',
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

// Returns today's date as YYYY-MM-DD in Kathmandu local time
function kathmanduDateString(date) {
  const d = new Date(date.getTime() + KATHMANDU_OFFSET_MINUTES * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T00:00:00Z');
  const b = new Date(dateStrB + 'T00:00:00Z');
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

// Picks a random UTC timestamp between now (or window start, whichever is later) and window end, for "today"
function pickRandomTimeInWindow(now) {
  const dayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowStart = new Date(dayStartUtc.getTime() + WINDOW_START_UTC_MINUTES * 60 * 1000);
  const windowEnd = new Date(dayStartUtc.getTime() + WINDOW_END_UTC_MINUTES * 60 * 1000);
  const earliestPick = now > windowStart ? now : windowStart;
  if (earliestPick >= windowEnd) return windowEnd; // window basically over, fire ASAP
  const randMs = earliestPick.getTime() + Math.random() * (windowEnd.getTime() - earliestPick.getTime());
  return new Date(randMs);
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
// NOTE: llama-3.3-70b-versatile and llama3-70b-8192 were both deprecated by Groq
// (announced June 17, 2026). Using their recommended replacements instead.

async function generateWithGroq(systemPrompt, userPrompt, env) {
  const models = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
  for (const model of models) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.85,
          max_tokens: 500,
        }),
      });

      if (!res.ok) {
        console.error(`Groq model ${model} failed: ${res.status}`);
        continue; // try next model
      }

      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content?.trim() || '';
      const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      if (!content) {
        console.error(`Groq model ${model} returned empty content`);
        continue; // try next model
      }

      console.log(`Groq model ${model} succeeded`);
      return content;
    } catch (e) {
      console.error(`Groq model ${model} threw: ${e.message}`);
      continue; // try next model
    }
  }

  throw new Error('All Groq models failed');
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

// ---------- auto-generate scheduling gate (every-other-day, random 4-5pm Kathmandu) ----------

async function nextAngle(env) {
  const row = await env.DB.prepare('SELECT last_index FROM angle_rotation WHERE id = 1').first();
  const lastIndex = row ? row.last_index : -1;
  const nextIndex = (lastIndex + 1) % ANGLES.length;
  await env.DB.prepare('UPDATE angle_rotation SET last_index = ? WHERE id = 1').bind(nextIndex).run();
  return ANGLES[nextIndex];
}

async function getScheduleState(env) {
  const row = await env.DB.prepare('SELECT last_post_date, next_run_at FROM auto_post_schedule WHERE id = 1').first();
  return row || { last_post_date: null, next_run_at: null };
}

async function setScheduleState(env, { last_post_date, next_run_at }) {
  await env.DB.prepare(
    `INSERT INTO auto_post_schedule (id, last_post_date, next_run_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_post_date = excluded.last_post_date,
       next_run_at = excluded.next_run_at`
  ).bind(last_post_date ?? null, next_run_at ?? null).run();
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

async function generateAndQueue(request, env) {
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

// Called on every cron tick that lands inside the 4-5pm Kathmandu window.
// Handles the every-other-day gate + picks/waits for a random time within the window.
async function runAutoGenerateGate(request, env) {
  const now = new Date();
  const todayStr = kathmanduDateString(now);
  const state = await getScheduleState(env);

  // Gate 1: every-other-day. Skip if we posted yesterday or already today.
  if (state.last_post_date) {
    const gap = daysBetween(state.last_post_date, todayStr);
    if (gap < 2) {
      return { skipped: true, reason: `last post was ${gap} day(s) ago, waiting for every-other-day gate`, last_post_date: state.last_post_date };
    }
  }

  // Gate 2: random time within window. If not yet picked for today, pick it and wait.
  const alreadyPickedToday = state.next_run_at && kathmanduDateString(new Date(state.next_run_at)) === todayStr;
  if (!alreadyPickedToday) {
    const randomTime = pickRandomTimeInWindow(now);
    await setScheduleState(env, { last_post_date: state.last_post_date, next_run_at: randomTime.toISOString() });
    return { skipped: true, reason: 'picked random run time for today', next_run_at: randomTime.toISOString() };
  }

  if (now < new Date(state.next_run_at)) {
    return { skipped: true, reason: 'waiting for picked time', next_run_at: state.next_run_at };
  }

  // Time to actually generate + queue the post.
  const result = await generateAndQueue(request, env);
  if (!result.error) {
    await setScheduleState(env, { last_post_date: todayStr, next_run_at: null });
  }
  return result;
}

async function handleAutoGenerate(request, env) {
  if (!checkCron(request, env)) return json({ error: 'Unauthorized' }, 401);
  const result = await runAutoGenerateGate(request, env);
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
    const now = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const inAutoGenerateWindow = utcMinutes >= WINDOW_START_UTC_MINUTES && utcMinutes <= WINDOW_END_UTC_MINUTES;

    if (inAutoGenerateWindow) {
      const fakeRequest = new Request('https://prajwolraj.com.np/api/auto-generate');
      const result = await runAutoGenerateGate(fakeRequest, env);
      console.log('auto-generate (cron):', JSON.stringify(result));
    } else {
      const result = await runPublishDue(env);
      console.log('publish-due (cron):', JSON.stringify(result));
    }
  },
};