/**
 * Simple session-based authentication for the prospecting tool.
 * Protects all routes behind a login page.
 * 
 * Password is stored hashed. Set via environment variable or first-run setup.
 * Sessions persist in SQLite so they survive restarts.
 */

import crypto from "crypto";
import db from "./db.js";

function isAuthEnforced() {
  const explicit = (process.env.ENFORCE_AUTH || "").toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return process.env.NODE_ENV === "production";
}

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );
`);

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
}

function getConfig(key) {
  const row = db.prepare("SELECT value FROM auth_config WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare("INSERT INTO auth_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function isAuthConfigured() {
  return !!getConfig("password_hash");
}

export function setupAuth(password) {
  const salt = crypto.randomBytes(32).toString("hex");
  const hash = hashPassword(password, salt);
  setConfig("password_hash", hash);
  setConfig("password_salt", salt);
  return true;
}

export function verifyPassword(password) {
  const storedHash = getConfig("password_hash");
  const salt = getConfig("password_salt");
  if (!storedHash || !salt) return false;
  const hash = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}

export function createSession(userAgent) {
  const token = crypto.randomBytes(48).toString("hex");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO auth_sessions (token, expires_at, user_agent) VALUES (?, ?, ?)").run(token, expires, userAgent || "");
  return token;
}

export function validateSession(token) {
  if (!token) return false;
  const session = db.prepare("SELECT * FROM auth_sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  return !!session;
}

export function destroySession(token) {
  db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
}

export function cleanExpiredSessions() {
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();
}

export function authMiddleware(req, res, next) {
  // Default to open access in local/dev unless explicitly enforced.
  if (!isAuthEnforced()) {
    return next();
  }

  if (req.path === "/api/auth/login" || req.path === "/api/auth/setup" || req.path === "/api/auth/status") {
    return next();
  }

  if (!isAuthConfigured()) {
    return next();
  }

  const token = req.headers["x-auth-token"] || req.cookies?.auth_token;
  if (validateSession(token)) {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Authentication required", needs_login: true });
  }

  next();
}
