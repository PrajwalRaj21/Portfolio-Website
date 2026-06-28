// /functions/auth/linkedin/login.js
// Redirects the browser to LinkedIn's OAuth 2.0 consent screen.
// Visit /auth/linkedin/login to start the "Connect LinkedIn" flow.

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/linkedin/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email w_member_social',
    state: crypto.randomUUID(), // CSRF protection (not persisted; this is a single-user admin tool)
  });

  return Response.redirect(
    `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`,
    302
  );
}
