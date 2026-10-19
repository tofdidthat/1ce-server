export async function setupUploadsSchema(db) {
  await db.query(`
    ALTER TABLE account_beats
    ADD COLUMN IF NOT EXISTS cover_key TEXT
  `)

  await db.query(`
    ALTER TABLE account_packs
    ADD COLUMN IF NOT EXISTS cover_key TEXT
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS account_uploads (
      id UUID PRIMARY KEY,

      user_id INTEGER NOT NULL
        REFERENCES account_users(id)
        ON DELETE CASCADE,

      kind TEXT NOT NULL
        CHECK (
          kind IN (
            'beat-cover',
            'pack-cover',
            'beat-audio',
            'beat-stems'
          )
        ),

      target_id UUID NOT NULL,

      temporary_key TEXT NOT NULL UNIQUE,

      expected_content_type TEXT NOT NULL,

      expected_size BIGINT NOT NULL
        CHECK (expected_size > 0),

      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
          status IN (
            'pending',
            'processing',
            'completed',
            'failed',
            'expired'
          )
        ),

      final_key TEXT,

      processing_started_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      expires_at TIMESTAMPTZ NOT NULL,

      completed_at TIMESTAMPTZ,

      CONSTRAINT account_uploads_expiry_check
        CHECK (expires_at > created_at),

      CONSTRAINT account_uploads_completion_check
        CHECK (
          status <> 'completed'
          OR (
            final_key IS NOT NULL
            AND completed_at IS NOT NULL
          )
        )
    )
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_uploads_user_created_idx
    ON account_uploads (
      user_id,
      created_at DESC
    )
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_uploads_pending_expiry_idx
    ON account_uploads (expires_at)
    WHERE status = 'pending'
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_uploads_processing_idx
    ON account_uploads (processing_started_at)
    WHERE status = 'processing'
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_uploads_target_idx
    ON account_uploads (
      user_id,
      kind,
      target_id
    )
  `)
}
