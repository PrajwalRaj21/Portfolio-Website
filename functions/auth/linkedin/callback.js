// /functions/auth/linkedin/callback.js
// LinkedIn redirects here after the user approves the consent screen.
// Exchanges the authorization code for an access token, fetches the
// member's identity (person URN + name) via the OpenID userinfo endpoint,
// and stores everything in D1.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return htmlResponse(`<h2>LinkedIn authorization failed</h2><p>${error}</p>`, 400);
  }
  if (!code) {
    return htmlResponse('<h2>Missing authorization code</h2>', 400);
  }

  const redirectUri = `${url.origin}/auth/linkedin/callback`;

  // 1. Exchange code for access token
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

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return htmlResponse(`<h2>Token exchange failed</h2><pre>${escapeHtml(errText)}</pre>`, 400);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const expiresInSeconds = tokenData.expires_in; // ~5184000 (60 days)
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  // 2. Fetch identity (OpenID userinfo endpoint — gives sub = person ID, name)
  const userRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!userRes.ok) {
    const errText = await userRes.text();
    return htmlResponse(`<h2>Failed to fetch LinkedIn identity</h2><pre>${escapeHtml(errText)}</pre>`, 400);
  }

  const userData = await userRes.json();
  const personUrn = `urn:li:person:${userData.sub}`;
  const name = userData.name || '';

  // 3. Store in D1 (single row, id = 1)
  await env.DB.prepare(
    `INSERT INTO linkedin_auth (id, access_token, person_urn, expires_at, name, connected_at)
     VALUES (1, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       person_urn = excluded.person_urn,
       expires_at = excluded.expires_at,
       name = excluded.name,
       connected_at = datetime('now')`
  )
    .bind(accessToken, personUrn, expiresAt, name)
    .run();

  return htmlResponse(
    `<h2>✅ LinkedIn connected</h2><p>Connected as <strong>${escapeHtml(name)}</strong>. Token valid until ${expiresAt}.</p><p><a href="/scheduler.html">Go to scheduler →</a></p>`,
    200
  );
}

function htmlResponse(body, status) {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;text-align:center">${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html' } }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
