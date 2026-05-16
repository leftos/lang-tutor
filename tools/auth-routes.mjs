import { timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { createSessionToken, getAccountStore } from './account-store.mjs';
import { isRecord, readRequestBody, writeJson } from './http.mjs';

const sessionCookieName = 'lang_tutor_session';
const csrfCookieName = 'lang_tutor_csrf';
const csrfHeaderName = 'x-csrf-token';
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const secureCookies =
  process.env.LANG_TUTOR_SECURE_COOKIES === 'true' || (process.env.LANG_TUTOR_SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production');
const requireAuth = process.env.LANG_TUTOR_REQUIRE_AUTH === 'true';

function sessionCookie(token, maxAge = sessionMaxAgeSeconds) {
  return serializeCookie(sessionCookieName, token, {
    httpOnly: true,
    maxAge,
    path: '/',
    sameSite: 'lax',
    secure: secureCookies,
  });
}

function csrfCookie(token, maxAge = sessionMaxAgeSeconds) {
  return serializeCookie(csrfCookieName, token, {
    maxAge,
    path: '/',
    sameSite: 'lax',
    secure: secureCookies,
  });
}

function appendSetCookie(response, cookie) {
  const current = response.getHeader('Set-Cookie');
  if (Array.isArray(current)) {
    response.setHeader('Set-Cookie', [...current, cookie]);
    return;
  }
  if (typeof current === 'string') {
    response.setHeader('Set-Cookie', [current, cookie]);
    return;
  }
  response.setHeader('Set-Cookie', cookie);
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function tokenMatches(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function csrfTokenFromRequest(request) {
  const cookies = parseCookie(request.headers.cookie ?? '');
  return cookies[csrfCookieName] || createSessionToken();
}

export function verifyCsrfToken(request) {
  const cookies = parseCookie(request.headers.cookie ?? '');
  const cookieToken = cookies[csrfCookieName];
  const headerToken = headerValue(request.headers[csrfHeaderName]);
  return Boolean(cookieToken && headerToken && tokenMatches(cookieToken, headerToken));
}

export function requireCsrfToken(request, response) {
  if (verifyCsrfToken(request)) return true;
  writeJson(response, 403, { error: 'Refresh the page and try again.' });
  return false;
}

async function readAuthBody(request) {
  const value = JSON.parse((await readRequestBody(request, 100_000)) || '{}');
  if (!isRecord(value)) return null;
  const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!emailPattern.test(email) || password.length < 8 || password.length > 200) return null;
  return { email, password };
}

async function writeAuthSession(response, store, user, token) {
  const session = store.createSession(user.id, token);
  await store.save();
  appendSetCookie(response, sessionCookie(token));
  appendSetCookie(response, csrfCookie(createSessionToken()));
  writeJson(response, 200, { user, expiresAt: session.expiresAt });
}

export async function readAuthSession(request) {
  const cookies = parseCookie(request.headers.cookie ?? '');
  const token = cookies[sessionCookieName];
  if (!token) return null;
  return (await getAccountStore()).findSession(token);
}

async function handleRegister(request, response) {
  const body = await readAuthBody(request);
  if (!body) {
    writeJson(response, 400, { error: 'Enter a valid email and a password with at least 8 characters.' });
    return;
  }

  const store = await getAccountStore();
  if (store.findAccountByEmail(body.email)) {
    writeJson(response, 409, { error: 'An account with that email already exists.' });
    return;
  }

  const user = store.createAccount(body.email, await hash(body.password));
  await writeAuthSession(response, store, user, createSessionToken());
}

async function handleLogin(request, response) {
  const body = await readAuthBody(request);
  if (!body) {
    writeJson(response, 400, { error: 'Enter a valid email and password.' });
    return;
  }

  const store = await getAccountStore();
  const account = store.findAccountByEmail(body.email);
  if (!account || !(await verify(account.password_hash, body.password))) {
    writeJson(response, 401, { error: 'Invalid email or password.' });
    return;
  }

  await writeAuthSession(response, store, { id: account.id, email: account.email, createdAt: account.created_at }, createSessionToken());
}

async function handleLogout(request, response) {
  const cookies = parseCookie(request.headers.cookie ?? '');
  const token = cookies[sessionCookieName];
  if (token && !requireCsrfToken(request, response)) return;
  if (token) {
    const store = await getAccountStore();
    store.deleteSession(token);
    await store.save();
  }
  appendSetCookie(response, sessionCookie('', 0));
  appendSetCookie(response, csrfCookie('', 0));
  writeJson(response, 200, { ok: true });
}

export async function handleAuthRequest(request, response) {
  if (!request.url?.startsWith('/api/auth')) return false;

  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url, 'http://127.0.0.1');

  try {
    if (url.pathname === '/api/auth/session' && request.method === 'GET') {
      appendSetCookie(response, csrfCookie(csrfTokenFromRequest(request)));
      writeJson(response, 200, { session: await readAuthSession(request), requireAuth });
      return true;
    }
    if (url.pathname === '/api/auth/register' && request.method === 'POST') {
      await handleRegister(request, response);
      return true;
    }
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      await handleLogin(request, response);
      return true;
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      await handleLogout(request, response);
      return true;
    }

    writeJson(response, 405, { error: 'Method not allowed' });
    return true;
  } catch {
    writeJson(response, 400, { error: 'Invalid auth request.' });
    return true;
  }
}
