import { Router } from 'express'
import crypto from 'node:crypto'

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUuid(value) {
  return typeof value === 'string' &&
    UUID_REGEX.test(value)
}

function normalizePackName(value) {
  return String(value || '')
    .trim()
    .slice(0, 100)
}

export function createPackRouter({
  db,
  getAccountFromRequest
}) {
  const router = Router()

  async function requireAccount(req, res) {
    const account =
      await getAccountFromRequest(req)

    if (!account) {
      res.status(401).json({
        authenticated: false
      })

      return null
    }

    return account
  }

  async function getOwnedPack(packId, userId) {
    const result = await db.query(
      `
        SELECT
          id,
          user_id,
          name,
          created_at,
          updated_at
        FROM account_packs
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [packId, userId]
    )

    return result.rows[0] || null
  }

  router.get('/me/packs', async (req, res) => {
    try {
      const account =
        await requireAccount(req, res)

      if (!account) return

      const result = await db.query(
        `
          SELECT
            p.id,
            p.name,
            p.created_at,
            p.updated_at,
            COUNT(pb.beat_id)::int AS beat_count
          FROM account_packs p
          LEFT JOIN account_pack_beats pb
            ON pb.pack_id = p.id
          WHERE p.user_id = $1
          GROUP BY
            p.id,
            p.name,
            p.created_at,
            p.updated_at
          ORDER BY
            p.created_at DESC,
            p.id DESC
        `,
        [account.id]
      )

      return res.json({
        packs: result.rows
      })
    } catch (error) {
      console.error('List packs error:', error)

      return res.status(500).json({
        error: 'Unable to list packs.'
      })
    }
  })

  router.post('/me/packs', async (req, res) => {
    const client = await db.connect()

    try {
      const account =
        await requireAccount(req, res)

      if (!account) return

      const name =
        normalizePackName(req.body?.name)

      const beatId = req.body?.beatId

      if (!name) {
        return res.status(400).json({
          error: 'Pack name is required.'
        })
      }

      if (
        beatId !== undefined &&
        beatId !== null &&
        !isValidUuid(beatId)
      ) {
        return res.status(400).json({
          error: 'Invalid beat ID.'
        })
      }

      const packId = crypto.randomUUID()

      await client.query('BEGIN')

      await client.query(
        `
          INSERT INTO account_packs (
            id,
            user_id,
            name
          )
          VALUES ($1, $2, $3)
        `,
        [packId, account.id, name]
      )

      if (beatId) {
        const beat = await client.query(
          `
            SELECT id
            FROM account_beats
            WHERE id = $1
              AND user_id = $2
            LIMIT 1
          `,
          [beatId, account.id]
        )

        if (!beat.rows.length) {
          await client.query('ROLLBACK')

          return res.status(404).json({
            error: 'Beat not found.'
          })
        }

        await client.query(
          `
            INSERT INTO account_pack_beats (
              pack_id,
              beat_id,
              position
            )
            VALUES ($1, $2, 0)
          `,
          [packId, beatId]
        )
      }

      await client.query('COMMIT')

      const pack = await getOwnedPack(
        packId,
        account.id
      )

      return res.status(201).json({
        pack
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      console.error('Create pack error:', error)

      return res.status(500).json({
        error: 'Unable to create pack.'
      })
    } finally {
      client.release()
    }
