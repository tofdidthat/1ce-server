import { Router } from 'express'
import { validateProfileInput } from '../profile-validation.js'

const readProfileSql = `
  SELECT p.links, p.version, p.updated_at,
    COALESCE(
      (SELECT array_agg(pb.beat_id ORDER BY pb.position)
       FROM account_profile_beats pb
       JOIN account_beats b ON b.id = pb.beat_id AND b.user_id = p.user_id
       WHERE pb.user_id = p.user_id), ARRAY[]::uuid[]
    ) AS beat_ids
  FROM account_profiles p WHERE p.user_id = $1
`
function toProfile(row) {
  return {
    beatIds: row?.beat_ids || [],
    links: row?.links || [],
    version: row?.version || 0,
    updatedAt: row?.updated_at || null
  }
}
export function createProfileRouter({ db, getAccountFromRequest, ready = () => true }) {
  const router = Router()
  router.use((req, res, next) => {
    if (!ready()) return res.status(503).json({ error: 'Database is initializing. Please try again.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  async function requireAccount(req, res) {
    const account = await getAccountFromRequest(req)
    if (!account) res.status(401).json({ authenticated: false, error: 'Sign in again to edit your profile.' })
    return account
  }
  router.get('/me/profile', async (req, res) => {
    try {
      const account = await requireAccount(req, res)
      if (!account) return
      const result = await db.query(readProfileSql, [account.id])
      return res.json({ profile: toProfile(result.rows[0]) })
    } catch (error) {
      console.error('Read profile error:', error)
      return res.status(500).json({ error: 'Unable to load your profile.' })
    }
  })
  router.put('/me/profile', async (req, res) => {
    let client
    let transaction = false
    try {
      const account = await requireAccount(req, res)
      if (!account) return
      let input
      try { input = validateProfileInput(req.body) }
      catch (error) { return res.status(400).json({ error: error.message }) }
      client = await db.connect()
      await client.query('BEGIN')
      transaction = true
      await client.query(`INSERT INTO account_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [account.id])
      const locked = await client.query(`SELECT version FROM account_profiles WHERE user_id = $1 FOR UPDATE`, [account.id])
      if (locked.rows[0].version !== input.version) {
        await client.query('ROLLBACK')
        transaction = false
        return res.status(409).json({ error: 'Your profile changed in another window. Reload the editor before saving.' })
      }
      if (input.beatIds.length) {
        const owned = await client.query(`
          SELECT id FROM account_beats
          WHERE user_id = $1 AND id = ANY($2::uuid[])
          FOR KEY SHARE
        `, [account.id, input.beatIds])
        if (owned.rows.length !== input.beatIds.length) {
          await client.query('ROLLBACK')
          transaction = false
          return res.status(400).json({ error: 'One or more selected beats are unavailable in your Library. Reload the editor.' })
        }
      }
      await client.query(`DELETE FROM account_profile_beats WHERE user_id = $1`, [account.id])
      if (input.beatIds.length) {
        await client.query(`
          INSERT INTO account_profile_beats (user_id, beat_id, position)
          SELECT $1, beat_id, (ordinality - 1)::integer
          FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(beat_id, ordinality)
        `, [account.id, input.beatIds])
      }
      await client.query(`
        UPDATE account_profiles SET links = $2::jsonb, version = version + 1, updated_at = NOW()
        WHERE user_id = $1
      `, [account.id, JSON.stringify(input.links)])
      const saved = await client.query(readProfileSql, [account.id])
      await client.query('COMMIT')
      transaction = false
      return res.json({ profile: toProfile(saved.rows[0]) })
    } catch (error) {
      if (client && transaction) await client.query('ROLLBACK').catch(() => {})
      console.error('Save profile error:', error)
      return res.status(500).json({ error: 'Unable to save your profile. Please try again.' })
    } finally {
      client?.release()
    }
  })
  return router
}
