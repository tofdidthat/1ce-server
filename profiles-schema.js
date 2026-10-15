export async function setupProfilesSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES account_users(id) ON DELETE CASCADE,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_profile_beats (
      user_id INTEGER NOT NULL REFERENCES account_profiles(user_id) ON DELETE CASCADE,
      beat_id UUID NOT NULL REFERENCES account_beats(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (user_id, beat_id),
      UNIQUE (user_id, position)
    )
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS account_profile_beats_beat_idx
    ON account_profile_beats(beat_id)
  `)
}
