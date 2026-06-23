export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS')
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' } });

    if (url.pathname === '/projects') {
      if (request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
        return new Response(JSON.stringify(results), { headers });
      }
      if (request.method === 'POST') {
        const p = await request.json();
        await env.DB.prepare('INSERT INTO projects (id,title,cat,description,tags,year,img,live,gh) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(p.id,p.title,p.cat,p.description,p.tags,p.year,p.img,p.live,p.gh).run();
        return new Response(JSON.stringify(p), { headers });
      }
      if (request.method === 'PATCH') {
        const p = await request.json();
        await env.DB.prepare('UPDATE projects SET title=?,cat=?,description=?,tags=?,year=?,img=?,live=?,gh=? WHERE id=?')
          .bind(p.title,p.cat,p.description,p.tags,p.year,p.img,p.live,p.gh,p.id).run();
        return new Response(JSON.stringify(p), { headers });
      }
      if (request.method === 'DELETE') {
        const p = await request.json();
        if (p.id === 'all') await env.DB.prepare('DELETE FROM projects').run();
        else await env.DB.prepare('DELETE FROM projects WHERE id=?').bind(p.id).run();
        return new Response('{}', { headers });
      }
    }
    return new Response('Not found', { status: 404 });
  }
};