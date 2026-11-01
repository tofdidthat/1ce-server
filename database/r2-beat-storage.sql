-- Preparatory migration for moving beat audio and stems to Cloudflare R2.
-- Existing rows remain readable from PostgreSQL.

ALTER TABLE account_beats
  ADD COLUMN IF NOT EXISTS audio_storage TEXT NOT NULL DEFAULT 'postgres';

ALTER TABLE account_beats
  ADD COLUMN IF NOT EXISTS audio_object_key TEXT;

ALTER TABLE account_beats
  ADD COLUMN IF NOT EXISTS stems_storage TEXT NOT NULL DEFAULT 'postgres';

ALTER TABLE account_beats
  ADD COLUMN IF NOT EXISTS stems_object_key TEXT;

ALTER TABLE account_beats
  ADD CONSTRAINT account_beats_audio_storage_check
  CHECK (audio_storage IN ('postgres', 'r2'));

ALTER TABLE account_beats
  ADD CONSTRAINT account_beats_stems_storage_check
  CHECK (stems_storage IN ('postgres', 'r2'));
