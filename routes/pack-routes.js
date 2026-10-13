import { Router } from 'express'
import crypto from 'node:crypto'

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUuid(value) {
  return typeof value === 'string' &&
    UUID_REGEX.test(value)
}

function getPackName(value) {
  const name = String(value || '').trim()

  if (!name || name.length > 100) {
    return null
  }

  return name
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

      const name = getPackName(req.body?.name)
      const beatId = req.body?.beatId

      if (!name) {
        return res.status(400).json({
          error:
            'Pack name must contain between 1 and 100 characters.'
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
      }

      const created = await client.query(
        `
          INSERT INTO account_packs (
            id,
            user_id,
            name
          )
          VALUES ($1, $2, $3)
          RETURNING
            id,
            user_id,
            name,
            created_at,
            updated_at
        `,
        [packId, account.id, name]
      )

      if (beatId) {
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

      return res.status(201).json({
        pack: created.rows[0]
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
  })

  router.patch(
    '/me/packs/:packId',
    async (req, res) => {
      try {
        const account =
          await requireAccount(req, res)

        if (!account) return

        const packId = req.params.packId

        if (!isValidUuid(packId)) {
          return res.status(404).json({
            error: 'Pack not found.'
          })
        }

        const name = getPackName(req.body?.name)

        if (!name) {
          return res.status(400).json({
            error:
              'Pack name must contain between 1 and 100 characters.'
          })
        }

        const result = await db.query(
          `
            UPDATE account_packs
            SET
              name = $1,
              updated_at = NOW()
            WHERE id = $2
              AND user_id = $3
            RETURNING
              id,
              user_id,
              name,
              created_at,
              updated_at
          `,
          [name, packId, account.id]
        )

        if (!result.rows.length) {
          return res.status(404).json({
            error: 'Pack not found.'
          })
        }

        return res.json({
          pack: result.rows[0]
        })
      } catch (error) {
        console.error('Update pack error:', error)

        return res.status(500).json({
          error: 'Unable to update pack.'
        })
      }
    }
  )

  router.delete(
    '/me/packs/:packId',
    async (req, res) => {
      try {
        const account =
          await requireAccount(req, res)

        if (!account) return

        const packId = req.params.packId

        if (!isValidUuid(packId)) {
          return res.status(404).json({
            error: 'Pack not found.'
          })
        }

        const result = await db.query(
          `
            DELETE FROM account_packs
            WHERE id = $1
              AND user_id = $2
            RETURNING id
          `,
          [packId, account.id]
        )

        if (!result.rows.length) {
          return res.status(404).json({
            error: 'Pack not found.'
          })
        }

        return res.json({
          ok: true
        })
      } catch (error) {
        console.error('Delete pack error:', error)

        return res.status(500).json({
          error: 'Unable to delete pack.'
        })
      }
    }
  )

  router.post(
    '/me/packs/:packId/beats',
    async (req, res) => {
      try {
        const account =
          await requireAccount(req, res)

        if (!account) return

        const packId = req.params.packId
        const beatId = req.body?.beatId

        if (!isValidUuid(packId)) {
          return res.status(404).json({
            error: 'Pack not found.'
          })
        }

        if (!isValidUuid(beatId)) {
          return res.status(400).json({
            error: 'Invalid beat ID.'
          })
        }

        const pack = await getOwnedPack(
  packId,
  account.id
)

if (!pack) {
  return res.status(404).json({
    error: 'Pack not found.'
  })
}

const beat = await db.query(
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
  return res.status(404).json({
    error: 'Beat not found.'
  })
}

        const positionResult = await db.query(
          `
            SELECT
              COALESCE(MAX(position), -1) + 1
              AS next_position
            FROM account_pack_beats
            WHERE pack_id = $1
          `,
          [packId]
        )

        const position =
          positionResult.rows[0].next_position

        const inserted = await db.query(
          `
            INSERT INTO account_pack_beats (
              pack_id,
              beat_id,
              position
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (pack_id, beat_id)
            DO NOTHING
            RETURNING beat_id
          `,
          [packId, beatId, position]
        )

        if (!inserted.rows.length) {
          return res.json({
            ok: true,
            alreadyAdded: true
          })
        }

        await db.query(
          `
            UPDATE account_packs
            SET updated_at = NOW()
            WHERE id = $1
          `,
          [packId]
        )

        return res.status(201).json({
          ok: true,
          alreadyAdded: false
        })
      } catch (error) {
        console.error(
          'Add beat to pack error:',
          error
        )

        return res.status(500).json({
          error: 'Unable to add beat to pack.'
        })
      }
    }
  )

  router.delete(
    '/me/packs/:packId/beats/:beatId',
    async (req, res) => {
      try {
        const account =
          await requireAccount(req, res)

        if (!account) return

        const packId = req.params.packId
        const beatId = req.params.beatId

        if (
          !isValidUuid(packId) ||
          !isValidUuid(beatId)
        ) {
          return res.status(404).json({
            error: 'Pack or beat not found.'
          })
        }

        const pack = await getOwnedPack(
          packId,
          account.id
        )

        if (!pack) {
          return res.status(404).json({
            error: 'Pack not found.'
          })
        }

        const result = await db.query(
          `
            DELETE FROM account_pack_beats
            WHERE pack_id = $1
              AND beat_id = $2
            RETURNING beat_id
          `,
          [packId, beatId]
        )

        if (!result.rows.length) {
          return res.status(404).json({
            error: 'Beat not found in pack.'
          })
        }

        await db.query(
          `
            UPDATE account_packs
            SET updated_at = NOW()
            WHERE id = $1
          `,
          [packId]
        )

        return res.json({
          ok: true
        })
      } catch (error) {
        console.error(
          'Remove beat from pack error:',
          error
        )

        return res.status(500).json({
          error:
            'Unable to remove beat from pack.'
        })
      }
    }
  )

  return router
}
