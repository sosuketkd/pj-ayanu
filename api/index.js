import { getRequestListener } from '@hono/node-server';
import { app } from '../lib/app.js';

// Run on Vercel's Node.js runtime (needed for bcryptjs).
// Vercel's Node runtime calls the default export as a Node (req, res) handler,
// so bridge Hono's fetch handler with @hono/node-server instead of hono/vercel
// (whose `handle` returns a Web fetch handler meant for the Edge runtime).
export const runtime = 'nodejs';

export default getRequestListener(app.fetch);
