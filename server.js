// Local dev server: serves index.html + the Hono API on one origin.
// Usage: DATABASE_URL=... JWT_SECRET=... npm run dev   (then open http://localhost:3000)
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { app as api } from './lib/app.js';

const root = new Hono();
root.route('/', api);                                  // /api/* handled by the Hono app
root.get('/', serveStatic({ path: './index.html' }));  // app shell
root.get('/*', serveStatic({ root: './' }));           // any other static asset

const port = Number(process.env.PORT) || 3000;
serve({ fetch: root.fetch, port }, () => {
  console.log(`綾整(Ayanu) running at http://localhost:${port}`);
});
