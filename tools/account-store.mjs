import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import initSqlJs from 'sql.js';

export const accountDbFilePath = resolve(process.env.LANG_TUTOR_DB_FILE ?? resolve(process.cwd(), '.local', 'account.sqlite'));

const sessionDurationMs = 1000 * 60 * 60 * 24 * 30;

const normalizeEmail = (email) => email.trim().toLowerCase();

export function sessionTokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
  };
}

async function readDatabaseFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

function defaultEntryState() {
  return { version: 1, entries: {} };
}

function parseEntryState(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      return defaultEntryState();
    }
    const entries = {};
    for (const [key, raw] of Object.entries(parsed.entries)) {
      if (typeof key === 'string' && typeof raw === 'string') entries[key] = raw;
    }
    return { version: 1, entries };
  } catch {
    return defaultEntryState();
  }
}

export class AccountStore {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  static async open(path = accountDbFilePath) {
    const SQL = await initSqlJs();
    const existing = await readDatabaseFile(path);
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    const store = new AccountStore(db, path);
    store.migrate();
    await store.persist();
    return store;
  }

  createAccount(email, passwordHash, now = new Date()) {
    const normalized = normalizeEmail(email);
    const id = randomUUID();
    const createdAt = now.toISOString();
    this.db.run(
      `insert into accounts (id, email, password_hash, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
      [id, normalized, passwordHash, createdAt, createdAt],
    );
    return rowToUser({ id, email: normalized, created_at: createdAt });
  }

  findAccountByEmail(email) {
    return this.getOne('select * from accounts where email = ?', [normalizeEmail(email)]);
  }

  createSession(userId, token, now = new Date()) {
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + sessionDurationMs).toISOString();
    this.db.run(
      `insert into sessions (id, user_id, token_hash, created_at, expires_at)
       values (?, ?, ?, ?, ?)`,
      [randomUUID(), userId, sessionTokenHash(token), createdAt, expiresAt],
    );
    return { expiresAt };
  }

  findSession(token, now = new Date()) {
    const row = this.getOne(
      `select sessions.user_id, accounts.email, accounts.created_at as account_created_at, sessions.expires_at
       from sessions
       join accounts on accounts.id = sessions.user_id
       where sessions.token_hash = ?`,
      [sessionTokenHash(token)],
    );
    if (!row || Date.parse(row.expires_at) <= now.getTime()) return null;
    return {
      user: rowToUser({ id: row.user_id, email: row.email, created_at: row.account_created_at }),
      expiresAt: row.expires_at,
    };
  }

  deleteSession(token) {
    this.db.run('delete from sessions where token_hash = ?', [sessionTokenHash(token)]);
  }

  readUserEntryState(userId) {
    const row = this.getOne('select state_json from user_states where user_id = ?', [userId]);
    if (!row) return defaultEntryState();
    return parseEntryState(row.state_json);
  }

  writeUserEntryState(userId, state, now = new Date()) {
    const savedState = {
      version: 1,
      entries: state.entries ?? {},
      updatedAt: now.toISOString(),
    };
    this.db.run(
      `insert into user_states (user_id, state_json, updated_at)
       values (?, ?, ?)
       on conflict(user_id) do update set
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
      [userId, JSON.stringify(savedState), savedState.updatedAt],
    );
    return savedState;
  }

  async save() {
    await this.persist();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.run('pragma foreign_keys = on');
    this.db.run(`
      create table if not exists accounts (
        id text primary key,
        email text not null unique,
        password_hash text not null,
        created_at text not null,
        updated_at text not null
      );
      create table if not exists sessions (
        id text primary key,
        user_id text not null references accounts(id) on delete cascade,
        token_hash text not null unique,
        created_at text not null,
        expires_at text not null
      );
      create table if not exists user_states (
        user_id text primary key references accounts(id) on delete cascade,
        state_json text not null,
        updated_at text not null
      );
      create index if not exists idx_sessions_token_hash on sessions(token_hash);
      create index if not exists idx_accounts_email on accounts(email);
    `);
  }

  getOne(sql, params = []) {
    const statement = this.db.prepare(sql, params);
    try {
      return statement.step() ? statement.getAsObject() : null;
    } finally {
      statement.free();
    }
  }

  async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, this.db.export());
  }
}

let accountStore = null;

export function getAccountStore() {
  accountStore ??= AccountStore.open();
  return accountStore;
}

