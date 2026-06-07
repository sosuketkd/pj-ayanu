// Hono application: mounts all API routes under /api.
import { Hono } from 'hono';
import auth from './routes/auth.js';
import workspaces from './routes/workspaces.js';
import members from './routes/members.js';
import invites from './routes/invites.js';
import type { AppEnv } from './types.js';

export const app = new Hono<AppEnv>().basePath('/api');

app.route('/', auth);
app.route('/', workspaces);
app.route('/', members);
app.route('/', invites);

export default app;
