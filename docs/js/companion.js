// companion.js — client for the optional local companion daemon (companion/stem-companion.py).
//
// The companion runs on the user's Mac and exposes a token-gated HTTP API on 127.0.0.1. This
// module handles pairing (via the URL fragment or a manual form), remembers the connection for the
// session, and wraps the endpoints. It is imported by app.js only when wiring the Companion card.

const STORE_KEY = 'companion';
let conn = null; // { base, token, info }

/** Parse "#companion=host:port&token=xxx" from the current URL (set by the companion's --open). */
export function readPairingFromHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const c = params.get('companion');
  const t = params.get('token');
  if (!c || !t) return null;
  const base = /^https?:\/\//.test(c) ? c.replace(/\/$/, '') : `http://${c}`;
  return { base, token: t };
}

export function loadSaved() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

function save(c) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ base: c.base, token: c.token }));
  } catch {
    /* ignore */
  }
}

export function forget() {
  conn = null;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

async function call(base, token, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-Companion-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Normalize a host[:port] or URL into an http base with no trailing slash. */
export function normalizeBase(input) {
  const s = String(input || '').trim().replace(/\/$/, '');
  if (!s) return '';
  return /^https?:\/\//.test(s) ? s : `http://${s}`;
}

export async function connect({ base, token }) {
  const info = await call(base, token, 'GET', '/health');
  conn = { base, token, info };
  save(conn);
  return info;
}

export function current() {
  return conn;
}
export function isConnected() {
  return !!conn;
}

export function extractDry(params) {
  if (!conn) throw new Error('not connected');
  return call(conn.base, conn.token, 'POST', '/extract-dry', params);
}
export function bounceWet(params) {
  if (!conn) throw new Error('not connected');
  return call(conn.base, conn.token, 'POST', '/bounce-wet', params);
}
export function listProjects(dir) {
  if (!conn) throw new Error('not connected');
  return call(conn.base, conn.token, 'POST', '/projects', { dir });
}
