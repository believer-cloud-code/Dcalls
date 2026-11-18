-- Dcalls trusted device control plane (Cloudflare D1)
-- Public keys and encrypted payloads only. Never store private crypto material.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account_identities (
  uid TEXT PRIMARY KEY NOT NULL,
  matrix_user_id TEXT NOT NULL UNIQUE,
  master_key_json TEXT NOT NULL,
  self_signing_key_json TEXT NOT NULL,
  user_signing_key_json TEXT NOT NULL,
  signatures_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_credentials (
  uid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  matrix_user_id TEXT NOT NULL,
  ed25519_key TEXT NOT NULL,
  device_keys_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  last_counter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (uid, device_id),
  FOREIGN KEY (uid) REFERENCES account_identities(uid)
);

CREATE INDEX IF NOT EXISTS idx_device_credentials_active
  ON device_credentials(uid, status);

CREATE TABLE IF NOT EXISTS one_time_keys (
  uid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_json TEXT NOT NULL,
  claimed_by TEXT,
  chat_id TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  PRIMARY KEY (uid, device_id, key_id),
  FOREIGN KEY (uid, device_id) REFERENCES device_credentials(uid, device_id)
);

CREATE INDEX IF NOT EXISTS idx_one_time_keys_available
  ON one_time_keys(uid, device_id, algorithm, claimed_by);

CREATE TABLE IF NOT EXISTS fallback_keys (
  uid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  key_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, device_id, key_id),
  FOREIGN KEY (uid, device_id) REFERENCES device_credentials(uid, device_id)
);

CREATE TABLE IF NOT EXISTS fallback_key_usage (
  uid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (uid, device_id, key_id),
  FOREIGN KEY (uid, device_id, key_id)
    REFERENCES fallback_keys(uid, device_id, key_id)
);

CREATE TABLE IF NOT EXISTS encrypted_device_inbox (
  recipient_uid TEXT NOT NULL,
  recipient_device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sender_uid TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  protocol TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (recipient_uid, recipient_device_id, event_id),
  FOREIGN KEY (recipient_uid, recipient_device_id)
    REFERENCES device_credentials(uid, device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_inbox_chat
  ON encrypted_device_inbox(recipient_uid, recipient_device_id, chat_id, created_at);

CREATE TABLE IF NOT EXISTS device_link_sessions (
  owner_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  hpke_public_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'joined', 'accepted', 'verified', 'cancelled')),
  joined_device_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verified_at INTEGER,
  PRIMARY KEY (owner_uid, session_id)
);

CREATE TABLE IF NOT EXISTS device_link_messages (
  owner_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_uid, session_id, message_id),
  FOREIGN KEY (owner_uid, session_id)
    REFERENCES device_link_sessions(owner_uid, session_id)
);

CREATE TABLE IF NOT EXISTS consumed_device_requests (
  uid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  consumed_at INTEGER NOT NULL,
  PRIMARY KEY (uid, device_id, request_id),
  FOREIGN KEY (uid, device_id) REFERENCES device_credentials(uid, device_id)
);

CREATE INDEX IF NOT EXISTS idx_consumed_requests_expiry
  ON consumed_device_requests(consumed_at);
