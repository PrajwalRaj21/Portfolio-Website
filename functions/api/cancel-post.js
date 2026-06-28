// /functions/api/cancel-post.js
// One-click cancel link from the review email. No admin password needed --
// protected instead by a per-post random token, since this is meant to be
// clicked straight from an email link.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');

  if (!id || !token) {
    return htmlResponse('<h2>Missing id or token</h2>', 400);
  }

  const post = await env.DB.prepare('SELECT * FROM scheduled_posts WHERE id = ?').bind(id).first();
  if (!post) {
    return htmlResponse('<h2>Post not found</h2>', 404);
  }
  if (post.cancel_token !== token) {
    return htmlResponse('<h2>Invalid cancel link</h2>', 403);
  }
  if (post.status !== 'awaiting_review' && post.status !== 'pending') {
    return htmlResponse(`<h2>Already ${post.status}</h2><p>This post was already ${post.status} and can't be cancelled now.</p>`, 200);
  }

  await env.DB.prepare("UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ?").bind(id).run();

  return htmlResponse('<h2>✅ Cancelled</h2><p>This post will not be published.</p>', 200);
}

function htmlResponse(body, status) {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center">${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html' } }
  );
}
