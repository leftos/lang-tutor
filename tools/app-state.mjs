/**
 * Repo-local browser state mirror.
 *
 * Browser localStorage is scoped to the exact origin, so localhost, 127.0.0.1,
 * LAN IPs, and port changes otherwise look like different apps. This endpoint
 * stores the app's lang-tutor:* values in an untracked repo-local file so every
 * local origin can hydrate from the same source.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountStore } from './account-store.mjs';
import { readAuthSession, requireCsrfToken } from './auth-routes.mjs';
import { writeJson } from './http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const STATE_FILE = join(REPO_ROOT, '.local', 'state', 'local-storage.json');
const KEY_PREFIX = 'lang-tutor:';
const SENSITIVE_KEYS = new Set(['lang-tutor:provider-settings']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function isStateKey(key) {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && key.length <= 256 && !SENSITIVE_KEYS.has(key);
}

function readState() {
  if (!existsSync(STATE_FILE)) {
    return { version: 1, entries: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || parsed.entries === null || typeof parsed.entries !== 'object') {
      return { version: 1, entries: {} };
    }
    const entries = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (isStateKey(key) && typeof value === 'string') {
        entries[key] = value;
      }
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, STATE_FILE);
}

function applySet(state, key, value) {
  if (!isStateKey(key) || typeof value !== 'string') {
    throw new Error('expected lang-tutor key and string value');
  }
  state.entries[key] = value;
}

function applyBulkSet(state, entries) {
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('expected entries object');
  }
  for (const [key, value] of Object.entries(entries)) {
    if (isStateKey(key) && typeof value === 'string') {
      state.entries[key] = value;
    }
  }
}

function applyDelete(state, key) {
  if (!isStateKey(key)) {
    throw new Error('expected lang-tutor key');
  }
  delete state.entries[key];
}

export async function handleStateRequest(req, res) {
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname !== '/state/local-storage') {
    return false;
  }

  try {
    const session = await readAuthSession(req);

    if (req.method === 'GET') {
      if (session) {
        sendJson(res, 200, { entries: (await getAccountStore()).readUserEntryState(session.user.id).entries });
        return true;
      }

      if (process.env.LANG_TUTOR_REQUIRE_AUTH === 'true') {
        writeJson(res, 401, { error: 'Sign in to load and save progress.' });
        return true;
      }

      sendJson(res, 200, { entries: readState().entries });
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }

    const body = JSON.parse(await readBody(req));
    if (session && !requireCsrfToken(req, res)) return true;
    if (!session && process.env.LANG_TUTOR_REQUIRE_AUTH === 'true') {
      writeJson(res, 401, { error: 'Sign in to save progress.' });
      return true;
    }

    const state = session ? (await getAccountStore()).readUserEntryState(session.user.id) : readState();
    switch (body.op) {
      case 'set':
        applySet(state, body.key, body.value);
        break;
      case 'bulkSet':
        applyBulkSet(state, body.entries);
        break;
      case 'delete':
        applyDelete(state, body.key);
        break;
      default:
        throw new Error('expected op set, bulkSet, or delete');
    }
    if (session) {
      const store = await getAccountStore();
      store.writeUserEntryState(session.user.id, state);
      await store.save();
    } else {
      writeState(state);
    }
    sendJson(res, 200, { ok: true });
    return true;
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    return true;
  }
}
