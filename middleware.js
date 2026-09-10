/**
 * Vercel Edge Middleware — HTTP Basic Auth in front of the entire dashboard.
 *
 * WHY THIS IS EDGE-ENFORCED AND NOT A REACT LOGIN SCREEN
 * -----------------------------------------------------
 * This app is a static Vite SPA. The actual payload is the 39 JSON snapshots under
 * /snapshots/*.json — 617 customer profiles with MRR, owner emails, AR and churn risk,
 * plus the revenue-recognition and QuickBooks journal data. Those are plain static files.
 * A password prompt rendered in React would stop nobody: you can fetch
 * /snapshots/customer_profiles.json directly and skip the UI entirely.
 *
 * So authentication has to happen BEFORE anything is served, on every path. That is what
 * this middleware does. Because it is HTTP Basic Auth, the browser then attaches the
 * credentials to every same-origin request automatically, so the SPA's own fetches of
 * /snapshots/*.json keep working with no application changes.
 *
 * FAIL CLOSED
 * -----------
 * If DASHBOARD_PASSWORD is not set, this serves 503 to everything rather than falling
 * open. A dark dashboard is a five-second fix; a public one cannot be un-leaked.
 *
 * CONFIGURATION (Vercel → Project → Settings → Environment Variables)
 *   DASHBOARD_PASSWORD  required, the shared password
 *   DASHBOARD_USER      optional, defaults to "allmoxy"
 * Set both for Production AND Preview, or preview deployments stay dark.
 */

import { next } from '@vercel/edge';

// Everything. No path is exempt: the JSON is the sensitive part, not the HTML.
export const config = { matcher: '/(.*)' };

const REALM = 'Allmoxy CFO Dashboard';
const DEFAULT_USER = 'allmoxy';

function deny(status, message, challenge) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    // Never let a shared cache (or Vercel's own edge cache) hold a protected response.
    'Cache-Control': 'no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (challenge) headers['WWW-Authenticate'] = `Basic realm="${REALM}", charset="UTF-8"`;
  return new Response(message, { status, headers });
}

/**
 * Length-safe, non-short-circuiting comparison. Basic Auth over TLS is not really
 * timing-attackable in this setting, but comparing secrets this way costs nothing.
 */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export default function middleware(request) {
  const expected = process.env.DASHBOARD_PASSWORD;
  const expectedUser = process.env.DASHBOARD_USER || DEFAULT_USER;

  if (!expected) {
    return deny(503, 'Dashboard unavailable: DASHBOARD_PASSWORD is not configured.', false);
  }

  const header = request.headers.get('authorization') || '';
  const sep = header.indexOf(' ');
  const scheme = sep < 0 ? '' : header.slice(0, sep);
  const encoded = sep < 0 ? '' : header.slice(sep + 1).trim();

  if (!encoded || scheme.toLowerCase() !== 'basic') {
    return deny(401, 'Authentication required.', true);
  }

  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return deny(401, 'Malformed credentials.', true);
  }

  // Split on the FIRST colon only — passwords may legitimately contain colons.
  const i = decoded.indexOf(':');
  const user = i < 0 ? '' : decoded.slice(0, i);
  const pass = i < 0 ? '' : decoded.slice(i + 1);

  // Evaluate both comparisons before branching, so a wrong username and a wrong
  // password are indistinguishable to the caller.
  const okUser = safeEqual(user, expectedUser);
  const okPass = safeEqual(pass, expected);
  if (!okUser || !okPass) return deny(401, 'Invalid credentials.', true);

  return next();
}
