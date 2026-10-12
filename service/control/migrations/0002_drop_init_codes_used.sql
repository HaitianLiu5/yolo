-- Owner pairing codes are now issued and checked by the home media node and
-- never stored in Cloudflare (Agent Note 2026-10-08-passkey-owner-sign-in), so
-- the used-init-code table from 0001 is no longer read or written. Nothing
-- references it.
DROP TABLE IF EXISTS init_codes_used;
