import { app } from '../src/app.js';

// Run on Vercel's Node.js runtime (needed for bcryptjs).
export const runtime = 'nodejs';

// Vercel's Node runtime invokes the default export as a Node (req, res) handler
// and pre-parses the request body — so reading the raw stream (as hono/vercel or
// @hono/node-server do) hangs on POST. Bridge to Hono by building a Web Request
// from Vercel's already-parsed req.body instead.
export default async function handler(req, res) {
  const host = req.headers.host || 'localhost';
  const url = `https://${host}${req.url}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }

  let body;
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && req.body != null) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      headers.set('content-type', 'application/json');
    }
    headers.delete('content-length'); // recomputed from the rebuilt body
  }

  const response = await app.fetch(new Request(url, { method, headers, body }));

  res.statusCode = response.status;
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : null;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie' && setCookies) return;
    res.setHeader(key, value);
  });
  if (setCookies && setCookies.length) res.setHeader('set-cookie', setCookies);

  res.end(Buffer.from(await response.arrayBuffer()));
}
