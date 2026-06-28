// /functions/api/generate-post.js
// Calls Groq's chat completions API to draft a LinkedIn post promoting Inferreach,
// given a topic/angle from the user.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function checkAuth(request, env) {
  const provided = request.headers.get('x-admin-password') || '';
  return provided && provided === env.ADMIN_PASSWORD;
}

const SYSTEM_PROMPT = `You write LinkedIn posts for Prajwol, founder of Inferreach (inferreach.com), an IT services & consulting company.
Rules:
- Hook in the first 1-2 lines (visible before "see more") — make people want to click.
- Short paragraphs, generous line breaks. LinkedIn's feed column is narrow.
- Conversational, confident, no corporate jargon, no excessive emojis (max 1-2 if any).
- Keep it under 1200 characters total.
- End with a soft call-to-action (e.g. a question, or pointing to inferreach.com) — not a hard sales pitch.
- Do not use hashtags unless the topic specifically calls for discoverability (max 3 if used).
- Output ONLY the post text. No preamble, no quotation marks around it, no "Here's a post:" framing.`;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!checkAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const { topic } = await request.json();
  if (!topic || !topic.trim()) return json({ error: 'topic is required' }, 400);

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Write a LinkedIn post about: ${topic}` },
      ],
      temperature: 0.8,
      max_tokens: 500,
    }),
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    return json({ error: 'Groq request failed', detail: errText }, 502);
  }

  const data = await groqRes.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  return json({ content });
}
