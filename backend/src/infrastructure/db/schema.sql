PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON access_grants(user_id);

-- user_id is nullable and deliberately carries NO foreign key: an
-- unknown-user attempt is still logged and has no valid user id, and a
-- FK here would reject exactly the audit rows that matter most.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  idempotency_key TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_key ON audit_events(idempotency_key);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- Grows one row per gate attempt, never pruned. At household volume this is
-- a few hundred KB a year; if it ever mattered, DELETE WHERE claimed_at < ?
-- is safe because a claim older than the idempotency window has no effect.
CREATE TABLE IF NOT EXISTS command_claims (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  cooling_until INTEGER NOT NULL,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_claimed ON command_claims(claimed_at);
CREATE INDEX IF NOT EXISTS idx_claims_key ON command_claims(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_claims_cooling ON command_claims(cooling_until);
