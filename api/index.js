import { handle } from 'hono/vercel';
import { app } from '../lib/app.js';

// Run on Vercel's Node.js runtime (needed for bcryptjs).
export const config = { runtime: 'nodejs' };

export default handle(app);
