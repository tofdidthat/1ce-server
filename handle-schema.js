export async function setupHandleSchema(db) {
  await db.query('ALTER TABLE account_users ADD COLUMN IF NOT EXISTS handle TEXT')
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS account_users_handle_unique_idx ON account_users(LOWER(handle)) WHERE handle IS NOT NULL`)
}
