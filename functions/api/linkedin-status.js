// /functions/api/linkedin-status.js
// Returns whether LinkedIn is connected, who as, and token expiry --
// used by the scheduler UI to show connection health.

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

  const auth = await env.DB.prepare('SELECT name, expires_at, connected_at FROM linkedin_auth WHERE id = 1').first();
  if (!auth) return json({ connected: false });

  const expired = new Date(auth.expires_at) < new Date();
  return json({
    connected: !expired,
    expired,
    name: auth.name,
    expires_at: auth.expires_at,
    connected_at: auth.connected_at,
  });
}
