/**
 * Authentication: scrypt password hashing, session helpers, CSRF tokens and a
 * login throttle. Accounts live in the users table; one of them is the admin
 * bootstrapped from the environment.
 *
 * The admin password comes from, first match wins:
 *   1. WIKIFLIP_ADMIN_PASSWORD_HASH  (scrypt$salt$hash — npm run hash-password)
 *   2. WIKIFLIP_ADMIN_PASSWORD       (plaintext, hashed at boot)
 *   3. A random password generated on first start and printed to the log
 *
 * Either environment variable is authoritative and re-applied on every boot,
 * which doubles as the password reset path. There is no default password.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import session from 'express-session';
import {
  createUser,
  db,
  getSetting,
  getUser,
  getUserByName,
  sanitizeUsername,
  setSetting,
  setUserPassword,
  updateUser,
} from './db.js';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let expected;
  try {
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(String(password), Buffer.from(parts[1], 'hex'), SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Make sure the environment's admin account exists and can log in.
 *
 * @returns {{username: string, generated: string|null}}
 */
export function ensureAdminUser() {
  const username = sanitizeUsername(process.env.WIKIFLIP_ADMIN_USER || 'admin') || 'admin';
  const envHash = (process.env.WIKIFLIP_ADMIN_PASSWORD_HASH || '').trim();
  const envPassword = process.env.WIKIFLIP_ADMIN_PASSWORD || '';

  if (envHash !== '' && !envHash.startsWith('scrypt$')) {
    throw new Error('WIKIFLIP_ADMIN_PASSWORD_HASH must be a scrypt hash (npm run hash-password).');
  }
  if (envHash === '' && envPassword !== '' && envPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`WIKIFLIP_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const fromEnv = envHash !== '' ? envHash : envPassword !== '' ? hashPassword(envPassword) : null;
  const existing = getUserByName(username);
  let generated = null;

  if (!existing) {
    // Either the pre-users release's stored hash, or a fresh random password.
    let passwordHash = fromEnv ?? getSetting('admin_password_hash');
    if (passwordHash === null) {
      generated = randomBytes(12).toString('base64url');
      passwordHash = hashPassword(generated);
    }
    createUser({ username, displayName: 'Administrator', passwordHash, isAdmin: true });
  } else {
    // The environment is the reset path: re-apply its password on every boot.
    // With no environment password the account keeps whatever it has, so nothing
    // is generated and nothing is logged.
    if (fromEnv !== null) setUserPassword(existing.id, fromEnv);
    if (!existing.isAdmin) updateUser(existing.id, { isAdmin: true });
  }
  setSetting('admin_password_hash', null);

  return { username, generated };
}

/** Verify a login. @returns the user, or null. */
export function authenticate(username, password) {
  const user = getUserByName(username);
  if (!user) return null;
  return verifyPassword(password, user.passwordHash) ? user : null;
}

/** Session secret survives restarts so logins are not dropped on deploy. */
export function sessionSecret() {
  const fromEnv = (process.env.WIKIFLIP_SESSION_SECRET || '').trim();
  if (fromEnv.length >= 16) return fromEnv;
  let secret = getSetting('session_secret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }
  return secret;
}

/* --------------------------------------------------------- session storage */

const sess = {
  get: db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?'),
  set: db.prepare(
    'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'
  ),
  destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
};

/** Sessions in SQLite: they survive a restart and cannot leak between users. */
export class SqliteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row = sess.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, data, cb) {
    try {
      const expires = data.cookie?.expires
        ? new Date(data.cookie.expires).getTime()
        : Date.now() + (data.cookie?.originalMaxAge ?? 12 * 60 * 60 * 1000);
      sess.set.run(sid, JSON.stringify(data), expires);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, data, cb) {
    this.set(sid, data, cb);
  }

  destroy(sid, cb) {
    try {
      sess.destroy.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}

setInterval(() => sess.prune.run(Date.now()), 60 * 60 * 1000).unref();

/* ------------------------------------------------------------------ CSRF */

export function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = randomBytes(32).toString('hex');
  return req.session.csrf;
}

function csrfValid(req) {
  const expected = req.session?.csrf;
  const sent = String(req.body?.csrf_token ?? req.get('x-csrf-token') ?? '');
  if (typeof expected !== 'string' || expected.length !== sent.length || sent === '') return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sent));
}

export function requireCsrf(req, res, next) {
  if (csrfValid(req)) return next();
  if (wantsJson(req)) {
    return res.status(403).json({ success: false, message: 'Your form expired. Reload the page and try again.' });
  }
  return res.status(403).type('text/plain').send('Invalid form token. Reload the page and try again.');
}

/* ------------------------------------------------------------------ guards */

export function wantsJson(req) {
  return (
    req.xhr ||
    req.body?.ajax === '1' ||
    (req.get('accept') || '').includes('application/json')
  );
}

/** Attach the signed-in user (or null) to every request. */
export function loadUser(req, res, next) {
  req.user = req.session?.uid ? getUser(req.session.uid) : null;
  // Account deleted mid-session: drop the session rather than half-trusting it.
  if (req.session?.uid && !req.user) return req.session.destroy(() => next());
  next();
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }
  const returnTo = req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//') ? req.originalUrl : '/';
  return res.redirect(`/login?return=${encodeURIComponent(returnTo)}`);
}

export function requireAdmin(req, res, next) {
  if (req.user?.isAdmin) return next();
  if (!req.user) return requireLogin(req, res, next);
  if (wantsJson(req)) {
    return res.status(403).json({ success: false, message: 'Administrators only.' });
  }
  return res.status(403).type('text/plain').send('Administrators only.');
}

/* ------------------------------------------------------- login throttling */

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip → { count, resetAt }

export function loginBlockedFor(ip) {
  const entry = attempts.get(ip);
  if (!entry) return 0;
  if (entry.resetAt <= Date.now()) {
    attempts.delete(ip);
    return 0;
  }
  return entry.count >= MAX_ATTEMPTS ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
}

export function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export function clearLoginFailures(ip) {
  attempts.delete(ip);
}

// ponytail: in-process throttle only — fine for one container, swap for a
// shared store if this ever runs behind more than one instance.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) if (entry.resetAt <= now) attempts.delete(ip);
}, WINDOW_MS).unref();
