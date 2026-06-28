// /functions/api/posts.js
// CRUD for scheduled LinkedIn posts.
// GET    -> list all (most recent first)
// POST   -> create a new scheduled post  { content, scheduled_for, topic_prompt?, generated_by_groq? }
// DELETE -> ?id=123  remove a pending post

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function checkAuth(request, env) {
  const provided = request.headers.get('x-admin-password') || '';
  return provided && provided === env.ADMIN_PASSWORD;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare(
    'SELECT * FROM scheduled_posts ORDER BY scheduled_for DESC'
  ).all();
  return json(results);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const p = await request.json();
  if (!p.content || !p.scheduled_for) {
    return json({ error: 'content and scheduled_for are required' }, 400);
  }

  const id = Date.now();
  await env.DB.prepare(
    `INSERT INTO scheduled_posts (id, content, scheduled_for, status, generated_by_groq, topic_prompt, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'))`
  )
    .bind(id, p.content, p.scheduled_for, p.generated_by_groq ? 1 : 0, p.topic_prompt || null)
    .run();

  return json({ success: true, id });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  await env.DB.prepare("UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'awaiting_review')").bind(id).run();
  return json({ success: true });
}
