import { randomUUID } from 'node:crypto'

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
  await db.query(`ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS public_id UUID`)
  await db.query(`ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT FALSE`)
  await db.query(`ALTER TABLE account_profiles ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS account_profiles_public_id_idx ON account_profiles(public_id)`)
  const existing = await db.query(`SELECT user_id FROM account_profiles WHERE public_id IS NULL`)
  for (const row of existing.rows) {
    await db.query(`UPDATE account_profiles SET public_id = $2 WHERE user_id = $1 AND public_id IS NULL`, [row.user_id, randomUUID()])
  }
  await db.query(`ALTER TABLE account_profiles ALTER COLUMN public_id SET NOT NULL`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS account_profile_beats (
      user_id INTEGER NOT NULL REFERENCES account_profiles(user_id) ON DELETE CASCADE,
      beat_id UUID NOT NULL REFERENCES account_beats(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (user_id, beat_id),
      UNIQUE (user_id, position)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS account_profile_beats_beat_idx ON account_profile_beats(beat_id)`)
}
