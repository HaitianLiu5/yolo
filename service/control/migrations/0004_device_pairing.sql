-- Device pairing (decision 15, RFC 8628 device authorization grant). A device
-- without a keyboard (the car) shows a QR code and a short code; the owner
-- approves it on a signed-in phone, and the device polls for its credential.
-- workers-oauth-provider has no device grant, so the control plane keeps
-- both tables itself.

-- One pairing attempt. Codes expire after 10 minutes and are used once:
-- pending → approved | denied → consumed. Only hashes of the device code are
-- stored; the user code is short and shown on screen, and only a signed-in
-- owner can enter it.
CREATE TABLE device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  device_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  device_id TEXT,                       -- the device created on approval
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_polled_at INTEGER
);
CREATE INDEX idx_device_codes_user ON device_codes(user_id, expires_at);

-- Credentials of paired devices: a long-lived bearer token per device, stored
-- as a hash. Removing the device deletes them (revocation).
CREATE TABLE device_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_device_tokens_device ON device_tokens(user_id, device_id);
