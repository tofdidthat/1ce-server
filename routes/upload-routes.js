import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import {
  CoverValidationError,
  validateCoverDeclaration
} from '../services/cover-image.js'

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const COVER_TABLES = Object.freeze({
  'beat-cover': 'account_beats',
  'pack-cover': 'account_packs'
})

const MAX_PENDING_UPLOADS = 10

function validUuid(value) {
  return (
    typeof value === 'string' &&
    UUID_REGEX.test(value)
  )
}

export function createUploadRouter({
  db,
  getAccountFromRequest,
  uploadStorage,
  ready = () => false
}) {
  const router = Router()

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')

    if (!ready()) {
      return res.status(503).json({
        error: 'Database is initializing. Try again shortly.'
      })
    }

    next()
  })

  router.post('/me/uploads', async (req, res) => {
    let client
    let transactionOpen = false

    try {
      const user = await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Sign in again to upload a cover.'
        })
      }

      const {
        kind,
        targetId,
        contentType,
        size
      } = req.body || {}

      const table = Object.hasOwn(COVER_TABLES, kind)
        ? COVER_TABLES[kind]
        : null

      if (!table) {
        return res.status(400).json({
          error: 'Only beat-cover and pack-cover uploads are supported.'
        })
      }

      if (!validUuid(targetId)) {
        return res.status(400).json({
          error: 'Invalid target ID.'
        })
      }

      validateCoverDeclaration({
        contentType,
        size
      })

      client = await db.connect()

      await client.query('BEGIN')
      transactionOpen = true

      // Serializa a criação de sessões por usuário.
      const account = await client.query(
        `
          SELECT id
          FROM account_users
          WHERE id = $1
          FOR UPDATE
        `,
        [user.id]
      )

      if (!account.rows.length) {
        await client.query('ROLLBACK')
        transactionOpen = false

        return res.status(401).json({
          error: 'Account unavailable.'
        })
      }

      // "table" vem apenas da lista fixa COVER_TABLES.
      const target = await client.query(
        `
          SELECT id
          FROM ${table}
          WHERE id = $1
            AND user_id = $2
          FOR SHARE
        `,
        [targetId, user.id]
      )

      if (!target.rows.length) {
        await client.query('ROLLBACK')
        transactionOpen = false

        return res.status(404).json({
          error: 'Beat or pack not found.'
        })
      }

      await client.query(
        `
          UPDATE account_uploads
          SET status = 'expired'
          WHERE user_id = $1
            AND status = 'pending'
            AND expires_at <= NOW()
        `,
        [user.id]
      )

      const pending = await client.query(
        `
          SELECT COUNT(*)::int AS total
          FROM account_uploads
          WHERE user_id = $1
            AND (
              (status = 'pending' AND expires_at > NOW())
              OR status = 'processing'
            )
        `,
        [user.id]
      )

      if (pending.rows[0].total >= MAX_PENDING_UPLOADS) {
        await client.query('ROLLBACK')
        transactionOpen = false

        return res.status(429).json({
          error: 'Too many unfinished uploads. Try again later.'
        })
      }

      const uploadId = randomUUID()

      const signed = await uploadStorage.createUploadUrl({
        userId: user.id,
        uploadId,
        contentType
      })

      const created = await client.query(
        `
          INSERT INTO account_uploads (
            id,
            user_id,
            kind,
            target_id,
            temporary_key,
            expected_content_type,
            expected_size,
            expires_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            NOW() + INTERVAL '5 minutes'
          )
          RETURNING expires_at
        `,
        [
          uploadId,
          user.id,
          kind,
          targetId,
          signed.key,
          contentType,
          size
        ]
      )

      await client.query('COMMIT')
      transactionOpen = false

      return res.status(201).json({
        uploadId,
        uploadUrl: signed.uploadUrl,
        method: 'PUT',
        headers: signed.headers,
        expiresAt: created.rows[0].expires_at
      })
    } catch (error) {
      if (client && transactionOpen) {
        await client.query('ROLLBACK').catch(() => {})
      }

      if (error instanceof CoverValidationError) {
        return res.status(400).json({
          error: error.message
        })
      }

      // Não registra a URL assinada nem o objeto completo do erro.
      console.error(
        'Create upload session failed:',
        error?.name || 'UnknownError'
      )

      return res.status(500).json({
        error: 'Unable to authorize this upload.'
      })
    } finally {
      client?.release()
    }
  })

  return router
}
