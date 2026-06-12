// Social login (Google / GitHub) via the OAuth 2.0 authorization-code flow.
// Configure per provider with env vars; a provider is enabled only when both
// its client id and secret are present:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
// Register each provider's redirect URI as: <APP_URL>/api/auth/oauth/<provider>/callback
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sql } from '../lib/db.js';
import { makeToken, readToken } from '../lib/auth.js';
import { setAuthCookie } from '../middleware/auth.js';
import { baseUrl, ownerOfEmail } from '../utils.js';
import type { AppEnv } from '../types.js';

const router = new Hono<AppEnv>();

type Profile = { providerUserId: string; email: string | null; name: string | null };

type Provider = {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authUrl: string;
  scope: string;
  authParams?: Record<string, string>;
  // Exchange the auth code for a token and return the normalized profile.
  exchange: (cfg: Provider, code: string, redirectUri: string) => Promise<Profile>;
};

async function postForm(url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  return res.json();
}

const PROVIDERS: Record<string, Provider> = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    authParams: { access_type: 'online', prompt: 'select_account' },
    async exchange(cfg, code, redirectUri) {
      const tok = await postForm('https://oauth2.googleapis.com/token', {
        code, client_id: cfg.clientId!, client_secret: cfg.clientSecret!,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      });
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (!res.ok) throw new Error(`profile fetch failed (${res.status})`);
      const u = await res.json() as any;
      return { providerUserId: String(u.id), email: u.email ?? null, name: u.name ?? null };
    },
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    authUrl: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
    async exchange(cfg, code, redirectUri) {
      const tok = await postForm('https://github.com/login/oauth/access_token', {
        code, client_id: cfg.clientId!, client_secret: cfg.clientSecret!, redirect_uri: redirectUri,
      });
      const headers = {
        Authorization: `Bearer ${tok.access_token}`,
        'User-Agent': 'ayanu', Accept: 'application/vnd.github+json',
      };
      const res = await fetch('https://api.github.com/user', { headers });
      if (!res.ok) throw new Error(`profile fetch failed (${res.status})`);
      const u = await res.json() as any;
      let email: string | null = u.email ?? null;
      if (!email) {
        // primary email is often private — fetch it explicitly (needs user:email scope)
        const er = await fetch('https://api.github.com/user/emails', { headers });
        if (er.ok) {
          const list = await er.json() as any[];
          const primary = list.find((e) => e.primary && e.verified) || list.find((e) => e.verified);
          email = primary ? primary.email : null;
        }
      }
      return { providerUserId: String(u.id), email, name: u.name ?? u.login ?? null };
    },
  },
};

export const OAUTH_PROVIDERS = Object.keys(PROVIDERS);

export function isConfigured(p: string): boolean {
  const cfg = PROVIDERS[p];
  return !!(cfg && cfg.clientId && cfg.clientSecret);
}

// Attach a provider identity to an ALREADY signed-in user (linking from settings).
// Throws 'taken' if the identity already belongs to a different account.
export async function linkIdentity(userId: string, provider: string, p: Profile): Promise<void> {
  const existing = await sql`select user_id from oauth_accounts where provider = ${provider} and provider_user_id = ${p.providerUserId}`;
  if (existing.length) {
    if (existing[0].user_id === userId) return;   // already linked to me — no-op
    throw new Error('taken');
  }
  await sql`insert into oauth_accounts (provider, provider_user_id, user_id) values (${provider}, ${p.providerUserId}, ${userId})`;
  // record the provider-verified email on this account if it isn't owned yet
  const email = (p.email || '').toLowerCase().trim();
  if (email && !(await ownerOfEmail(email))) {
    await sql`insert into user_emails (user_id, email, verified) values (${userId}, ${email}, true)
      on conflict (user_id, email) do update set verified = true`;
  }
}

function callbackUri(c: any, provider: string): string {
  return `${baseUrl(c)}/api/auth/oauth/${provider}/callback`;
}

// Find or create the user for this identity, then issue the login cookie.
async function loginWithIdentity(c: any, provider: string, p: Profile): Promise<void> {
  const email = (p.email || '').toLowerCase().trim();
  if (!email) throw new Error('no email from provider');

  let userId: string;
  const linked = await sql`select user_id from oauth_accounts where provider = ${provider} and provider_user_id = ${p.providerUserId}`;
  if (linked.length) {
    userId = linked[0].user_id;
  } else {
    // Link to whichever account already owns this (provider-verified) email; else create one.
    const existing = await sql`select user_id from user_emails where lower(email) = ${email}`;
    if (existing.length) {
      userId = existing[0].user_id;
    } else {
      const created = await sql`insert into users (email, username) values (${email}, ${p.name || null}) returning id`;
      userId = created[0].id;
      await sql`
        insert into user_emails (user_id, email, verified, is_primary)
        values (${userId}, ${email}, true, true)`;
    }
    await sql`
      insert into oauth_accounts (provider, provider_user_id, user_id)
      values (${provider}, ${p.providerUserId}, ${userId})
      on conflict (provider, provider_user_id) do nothing`;
  }

  // The provider verified this email — make sure it's recorded as a verified
  // address of the account (no-op if already present / owned).
  if (!(await ownerOfEmail(email))) {
    await sql`insert into user_emails (user_id, email, verified) values (${userId}, ${email}, true)
      on conflict (user_id, email) do update set verified = true`;
  }

  const u = await sql`select email from users where id = ${userId}`;
  setAuthCookie(c, await makeToken({ id: userId, email: u[0].email }));
}

// Which providers are usable (so the login screen only shows configured buttons).
router.get('/auth/oauth/providers', (c) =>
  c.json({ google: isConfigured('google'), github: isConfigured('github') }));

// Step 1: redirect the browser to the provider's consent screen.
router.get('/auth/oauth/:provider', (c) => {
  const provider = c.req.param('provider')!;
  const cfg = PROVIDERS[provider];
  if (!cfg || !isConfigured(provider)) return c.json({ error: '未対応のログイン方法です' }, 400);

  const state = crypto.randomUUID();
  setCookie(c, 'oauth_state', state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
  // `?mode=link` attaches the identity to the signed-in user instead of logging in.
  if (c.req.query('mode') === 'link') {
    setCookie(c, 'oauth_mode', 'link', { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
  } else {
    deleteCookie(c, 'oauth_mode', { path: '/' });
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId!,
    redirect_uri: callbackUri(c, provider),
    response_type: 'code',
    scope: cfg.scope,
    state,
    ...(cfg.authParams || {}),
  });
  return c.redirect(`${cfg.authUrl}?${params.toString()}`);
});

// Step 2: provider redirects back here with ?code&state. Verify, exchange, log in.
router.get('/auth/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider')!;
  const cfg = PROVIDERS[provider];
  if (!cfg || !isConfigured(provider)) return c.redirect('/?oauth_error=unsupported');

  const code = c.req.query('code');
  const state = c.req.query('state');
  const saved = getCookie(c, 'oauth_state');
  const mode = getCookie(c, 'oauth_mode');
  deleteCookie(c, 'oauth_state', { path: '/' });
  deleteCookie(c, 'oauth_mode', { path: '/' });
  if (!code || !state || state !== saved) {
    return c.redirect(mode === 'link' ? '/?account=1&link_error=state' : '/?oauth_error=state');
  }

  // Linking flow: attach the identity to the signed-in user, back to the account screen.
  if (mode === 'link') {
    const payload = await readToken(getCookie(c, 'token') || '');
    if (!payload) return c.redirect('/?account=1&link_error=auth');
    try {
      const profile = await cfg.exchange(cfg, code, callbackUri(c, provider));
      await linkIdentity(payload.sub as string, provider, profile);
      return c.redirect('/?account=1&link=ok');
    } catch (e) {
      const msg = (e as Error).message === 'taken' ? 'taken' : 'failed';
      console.error('[ayanu] oauth link error', e);
      return c.redirect('/?account=1&link_error=' + msg);
    }
  }

  try {
    const profile = await cfg.exchange(cfg, code, callbackUri(c, provider));
    await loginWithIdentity(c, provider, profile);
    return c.redirect('/');
  } catch (e) {
    console.error('[ayanu] oauth callback error', e);
    return c.redirect('/?oauth_error=failed');
  }
});

export default router;
