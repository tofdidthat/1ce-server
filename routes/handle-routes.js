import { Router } from 'express'
import { normalizeHandle } from '../handle-validation.js'

export function createHandleRouter({ db, getAccountFromRequest, ready = () => true }) {
  const router = Router()
  async function account(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    if (!ready()) { res.status(503).json({ error: 'Database is initializing. Try again shortly.' }); return null }
    const user = await getAccountFromRequest(req)
    if (!user) res.status(401).json({ error: 'Sign in again to edit your username.' })
    return user
  }
  router.get('/me/handle', async (req, res) => {
    try {
      const user = await account(req, res)
      if (!user) return
      const result = await db.query('SELECT handle FROM account_users WHERE id = $1', [user.id])
      if (!result.rows.length) return res.status(404).json({ error: 'Account unavailable.' })
      res.json({ handle: result.rows[0].handle || null })
    } catch (error) {
      console.error('Read handle error:', error)
      res.status(500).json({ error: 'Unable to load your username.' })
    }
  })
  router.patch('/me/handle', async (req, res) => {
    try {
      const user = await account(req, res)
      if (!user) return
      let handle
      try { handle = normalizeHandle(req.body?.handle) }
      catch (error) { return res.status(400).json({ error: error.message }) }
      const result = await db.query(`UPDATE account_users SET handle = $2, updated_at = NOW() WHERE id = $1 RETURNING handle`, [user.id, handle])
      if (!result.rows.length) return res.status(404).json({ error: 'Account unavailable.' })
      return res.json({ handle: result.rows[0].handle })
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'account_users_handle_unique_idx') {
        return res.status(409).json({ error: 'This username is already taken. Choose another.' })
      }
      console.error('Save handle error:', error)
      return res.status(500).json({ error: 'Unable to save your username.' })
    }
  })
  return router
}
