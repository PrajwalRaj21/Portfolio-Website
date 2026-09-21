// Syncs GitHub repos tagged 'portfolio' into Cloudflare D1.
// Upserts on `slug` so existing rows are updated, never duplicated.

const GITHUB_USER = process.env.GITHUB_USER;
const GH_TOKEN    = process.env.GITHUB_TOKEN;
const CF_TOKEN    = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT  = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_DB       = process.env.CLOUDFLARE_DATABASE_ID;
const TOPIC       = 'portfolio';

if (!GITHUB_USER || !CF_TOKEN || !CF_ACCOUNT || !CF_DB) {
  console.error('Missing env vars. Need GITHUB_USER, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID.');
  process.exit(1);
}

// ------------------------------------------------------------------
// 1. Fetch GitHub repos
// ------------------------------------------------------------------
const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(GH_TOKEN && { Authorization: `Bearer ${GH_TOKEN}` }),
};

const repoRes = await fetch(
  `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=pushed`,
  { headers: ghHeaders }
);
if (!repoRes.ok) throw new Error(`GitHub ${repoRes.status}: ${await repoRes.text()}`);
const repos = await repoRes.json();

const projects = repos
  .filter(r => !r.fork && !r.archived && r.topics?.includes(TOPIC))
  .map(r => ({
    slug:        r.name,
    title:       r.name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    description: r.description ?? '',
    tags:        (r.topics || []).filter(t => t !== TOPIC).join(', '),
    gh:          r.html_url,
    live:        r.homepage || '',
    img:         `https://opengraph.githubassets.com/main/${GITHUB_USER}/${r.name}`,
    language:    r.language || '',
    stars:       r.stargazers_count ?? 0,
    updated_at:  r.pushed_at,
  }));

if (!projects.length) {
  console.log(`No repos tagged "${TOPIC}". Nothing to sync.`);
  process.exit(0);
}

console.log(`Found ${projects.length} repo(s) tagged "${TOPIC}". Syncing...\n`);

// ------------------------------------------------------------------
// 2. Upsert into D1 via REST API — one repo at a time
// ------------------------------------------------------------------
const d1Url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${CF_DB}/query`;

const sql = `
  INSERT INTO projects (slug, title, description, tags, img, live, gh, language, stars, updated_at, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'github')
  ON CONFLICT(slug) DO UPDATE SET
    language   = excluded.language,
    stars      = excluded.stars,
    updated_at = excluded.updated_at,
    gh         = excluded.gh,
    img        = COALESCE(NULLIF(projects.img, ''),  excluded.img),
    live       = COALESCE(NULLIF(projects.live, ''), excluded.live),
    source     = 'github'
`;

let ok = 0, failed = 0;

for (const p of projects) {
  const params = [
    p.slug, p.title, p.description, p.tags,
    p.img, p.live, p.gh, p.language, p.stars, p.updated_at,
  ];

  const res = await fetch(d1Url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  const json = await res.json();

  if (!res.ok || json.success === false) {
    console.error(`✗ ${p.slug}`);
    console.error(JSON.stringify(json.errors ?? json, null, 2));
    failed++;
  } else {
    console.log(`✓ ${p.slug}`);
    ok++;
  }
}

console.log(`\nDone. ${ok} synced, ${failed} failed.`);
if (failed) process.exit(1);