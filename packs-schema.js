export async function setupPacksSchema(db) {
  await db.query(`
    ALTER TABLE account_users
    ADD COLUMN IF NOT EXISTS handle TEXT
  `)

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
      account_users_handle_lower_unique_idx
    ON account_users (LOWER(handle))
    WHERE handle IS NOT NULL
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS account_packs (
      id UUID PRIMARY KEY,

      user_id INTEGER NOT NULL
        REFERENCES account_users(id)
        ON DELETE CASCADE,

      name TEXT NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      CONSTRAINT account_packs_name_length_check
        CHECK (
          char_length(btrim(name))
          BETWEEN 1 AND 100
        )
    )
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS account_pack_beats (
      pack_id UUID NOT NULL
        REFERENCES account_packs(id)
        ON DELETE CASCADE,

      beat_id UUID NOT NULL
        REFERENCES account_beats(id)
        ON DELETE CASCADE,

      position INTEGER NOT NULL
        DEFAULT 0,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      CONSTRAINT account_pack_beats_position_check
        CHECK (position >= 0),

      PRIMARY KEY (pack_id, beat_id)
    )
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_packs_user_created_idx
    ON account_packs (
      user_id,
      created_at DESC,
      id
    )
  `)

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      account_pack_beats_beat_idx
    ON account_pack_beats (beat_id)
  `)
}
