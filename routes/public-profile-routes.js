import { Router } from 'express'
import { audioRange } from '../beat-library.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHUNK_SIZE = 1024 * 1024

export function createPublicProfileRouter({ db, ready = () => true }) {
  const router = Router()
  router.use('/profiles', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    if (!ready()) return res.status(503).json({ error: 'Service is initializing. Try again shortly.' })
    next()
  })
  router.get('/profiles/:publicId', async (req, res) => {
    if (!UUID.test(req.params.publicId)) return res.status(404).json({ error: 'Profile unavailable.' })
    try {
      const result = await db.query(`
        SELECT u.handle, u.picture, p.links, p.public_id,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', b.id, 'title', b.title, 'duration', b.duration, 'createdAt', b.created_at
            ) ORDER BY pb.position)
            FROM account_profile_beats pb
            JOIN account_beats b ON b.id = pb.beat_id AND b.user_id = p.user_id
            WHERE pb.user_id = p.user_id
          ), '[]'::jsonb) AS beats
        FROM account_profiles p
        JOIN account_users u ON u.id = p.user_id
        WHERE p.public_id = $1 AND p.published = TRUE
        LIMIT 1
      `, [req.params.publicId])
      if (!result.rows.length) return res.status(404).json({ error: 'Profile unavailable.' })
      const row = result.rows[0]
    return res.json({
  profile: {
    publicId: row.public_id,
    handle: row.handle || null,
    name: row.handle ? `@${row.handle}` : '1CE artist',
    picture: row.picture || null,
    links: row.links || [],
    beats: row.beats || []
  }
})
    } catch (error) {
      console.error('Public profile read error:', error)
      return res.status(500).json({ error: 'Unable to load profile.' })
    }
  })
  router.get('/profiles/:publicId/beats/:beatId/audio', async (req, res) => {
    if (!UUID.test(req.params.publicId) || !UUID.test(req.params.beatId)) return res.sendStatus(404)
    let client
    try {
      client = await db.connect()
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const authorized = await client.query(`
        SELECT b.audio_size
        FROM account_profiles p
        JOIN account_profile_beats pb ON pb.user_id = p.user_id
        JOIN account_beats b ON b.id = pb.beat_id AND b.user_id = p.user_id
        WHERE p.public_id = $1 AND p.published = TRUE AND b.id = $2
        LIMIT 1
      `, [req.params.publicId, req.params.beatId])
      if (!authorized.rows.length) return res.sendStatus(404)
      const size = Number(authorized.rows[0].audio_size)
      if (!Number.isSafeInteger(size) || size <= 0) return res.sendStatus(404)
      res.setHeader('Accept-Ranges', 'bytes')
      const range = req.headers.range === 'bytes=-0' ? null : audioRange(req.headers.range, size)
      if (!range) { res.setHeader('Content-Range', 'bytes */' + size); return res.sendStatus(416) }
      const { start, end, partial } = range
      res.status(partial ? 206 : 200)
      res.setHeader('Content-Type', 'audio/mpeg')
      res.setHeader('Content-Length', end - start + 1)
      if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      if (req.method === 'HEAD') return res.end()
      for (let index = Math.floor(start / CHUNK_SIZE); index <= Math.floor(end / CHUNK_SIZE); index++) {
        if (res.destroyed) return
        const chunk = await client.query(`SELECT data FROM account_beat_audio WHERE beat_id = $1 AND chunk_index = $2`, [req.params.beatId, index])
        if (!chunk.rows.length) throw new Error('Missing audio chunk')
        const data = Buffer.from(chunk.rows[0].data)
        const offset = index * CHUNK_SIZE
        const part = data.subarray(Math.max(0, start - offset), Math.min(data.length, end - offset + 1))
        if (!res.write(part)) await new Promise(resolve => {
          const finish = () => { res.off('drain', finish); res.off('close', finish); resolve() }
          res.once('drain', finish); res.once('close', finish)
        })
      }
      res.end()
    } catch (error) {
      console.error('Public profile audio error:', error)
      if (res.headersSent) res.destroy(error)
      else res.status(500).json({ error: 'Unable to play audio.' })
    } finally {
      if (client) { try { await client.query('ROLLBACK') } finally { client.release() } }
    }
  })
  return router
}
