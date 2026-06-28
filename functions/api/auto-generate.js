// /functions/api/auto-generate.js
// Called daily by the cron Worker. No human input:
//  1. Picks the next angle from a rotating list
//  2. Asks Groq to write a post using that angle as a loose brief
//  3. Saves it with status 'awaiting_review' and publish_at = now + 30 min
//  4. Emails a review link + one-click cancel link via Resend
//
// Protected by the same shared CRON_SECRET as publish-due.js (this is
// machine-to-machine, not something a logged-in admin clicks).

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
    brief: 'Talk about the kind of problem Inferreach solves for clients and why it matters, without naming a specific real client unless one is provided. Frame it around the client\'s pain point, not a sales pitch.',
  },
];

const SYSTEM_PROMPT = `You write LinkedIn posts for Prajwol, founder of Inferreach (inferreach.com), an IT services & consulting company.
Rules:
- Hook in the first 1-2 lines (visible before "see more") -- make people want to click.
- Short paragraphs, generous line breaks. LinkedIn's feed column is narrow.
- Conversational, confident, no corporate jargon, no excessive emojis (max 1-2 if any).
- Keep it under 1200 characters total.
- End with a soft call-to-action (e.g. a question, or pointing to inferreach.com) -- not a hard sales pitch.
- Do not use hashtags unless the topic specifically calls for discoverability (max 3 if used).
- Do not invent specific facts, client names, numbers, or stats that weren't given to you. Write generally rather than fabricate specifics.
- Output ONLY the post text. No preamble, no quotation marks around it, no "Here's a post:" framing.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function nextAngle(env) {
  const row = await env.DB.prepare('SELECT last_index FROM angle_rotation WHERE id = 1').first();
  const lastIndex = row ? row.last_index : -1;
  const nextIndex = (lastIndex + 1) % ANGLES.length;
  await env.DB.prepare('UPDATE angle_rotation SET last_index = ? WHERE id = 1').bind(nextIndex).run();
  return ANGLES[nextIndex];
}

async function generateWithGroq(angle, env) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: angle.brief },
      ],
      temperature: 0.9,
      max_tokens: 500,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq request failed: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function sendReviewEmail({ content, angle, cancelUrl, reviewUrl }, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
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
  if (!res.ok) {
    console.error('Resend email failed:', await res.text());
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const provided = request.headers.get('x-cron-secret') || '';
  if (!provided || provided !== env.CRON_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const angle = await nextAngle(env);
  let content;
  try {
    content = await generateWithGroq(angle, env);
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  const id = Date.now();
  const cancelToken = crypto.randomUUID();
  const publishAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO scheduled_posts (id, content, scheduled_for, status, generated_by_groq, auto_generated, angle, cancel_token, created_at)
     VALUES (?, ?, ?, 'awaiting_review', 1, 1, ?, ?, datetime('now'))`
  )
    .bind(id, content, publishAt, angle.key, cancelToken)
    .run();

  const origin = new URL(request.url).origin;
  const cancelUrl = `${origin}/api/cancel-post?id=${id}&token=${cancelToken}`;
  const reviewUrl = `${origin}/scheduler.html`;

  await sendReviewEmail({ content, angle, cancelUrl, reviewUrl }, env);

  return json({ success: true, id, angle: angle.key, publishAt });
}
