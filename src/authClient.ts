import { appUrl } from './appUrls';

export type AccountUser = {
  id: string;
  email: string;
  createdAt: string;
};

export type AccountSession = {
  user: AccountUser;
  expiresAt: string;
};

export type AuthCredentials = {
  email: string;
  password: string;
};

const csrfCookieName = 'lang_tutor_csrf';
let authRequired = false;
let sessionActive = false;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const errorMessage = (body: unknown, fallback: string): string => (isRecord(body) && typeof body.error === 'string' ? body.error : fallback);

const decodeCookieValue = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const readCookie = (name: string): string | null => {
  const prefix = `${name}=`;
  const cookie = document.cookie
    .split(';')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix))
    ?.slice(prefix.length);
  return cookie ? decodeCookieValue(cookie) : null;
};

export const csrfHeader = (): Record<string, string> => {
  const token = readCookie(csrfCookieName);
  return token ? { 'X-CSRF-Token': token } : {};
};

export const isAuthRequired = (): boolean => authRequired;

export const hasAuthSession = (): boolean => sessionActive;

export const canUseHostedTooling = (): boolean => !authRequired || sessionActive;

const normalizeSession = (value: unknown): AccountSession | null => {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  const { id, email, createdAt } = value.user;
  const { expiresAt } = value;
  if (typeof id !== 'string' || typeof email !== 'string' || typeof createdAt !== 'string' || typeof expiresAt !== 'string') {
    return null;
  }
  return { user: { id, email, createdAt }, expiresAt };
};

const postAuth = async (url: string, credentials: AuthCredentials): Promise<AccountSession> => {
  const response = await fetch(appUrl(url), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...csrfHeader(),
    },
    body: JSON.stringify(credentials),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(body, `Account request failed: ${response.status}`));
  }
  const session = normalizeSession(body);
  if (!session) throw new Error('Account response did not include a session.');
  return session;
};

export const loadAuthSession = async (): Promise<AccountSession | null> => {
  const response = await fetch(appUrl('/api/auth/session'), {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(body, `Could not load account session: ${response.status}`));
  }
  authRequired = isRecord(body) && body.requireAuth === true;
  const session = isRecord(body) ? normalizeSession(body.session) : null;
  sessionActive = session !== null;
  return session;
};

export const registerAccount = async (credentials: AuthCredentials): Promise<AccountSession> => {
  const session = await postAuth('/api/auth/register', credentials);
  sessionActive = true;
  return session;
};

export const loginAccount = async (credentials: AuthCredentials): Promise<AccountSession> => {
  const session = await postAuth('/api/auth/login', credentials);
  sessionActive = true;
  return session;
};

export const logoutAccount = async (): Promise<void> => {
  const response = await fetch(appUrl('/api/auth/logout'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...csrfHeader(),
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(body, `Could not sign out: ${response.status}`));
  }
  sessionActive = false;
};
