import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import {
  COVER_MAX_BYTES,
  CoverValidationError,
  validateCoverDeclaration,
  prepareCover
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

  router.post('/me/uploads/:uploadId/complete', async (req, res) => {
    let client
    let transactionOpen = false
    let publishedKey = null
    let commitAttempted = false

    try {
      const user = await getAccountFromRequest(req)

      if (!user) {
        return res.status(401).json({
          error: 'Sign in again to complete this upload.'
        })
      }

      const { uploadId } = req.params

      if (!validUuid(uploadId)) {
        return res.status(400).json({
          error: 'Invalid upload ID.'
        })
      }

      client = await db.connect()
      await client.query('BEGIN')
      transactionOpen = true

      const result = await client.query(
        `
          SELECT *,
            expires_at <= NOW() AS expired
          FROM account_uploads
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE NOWAIT
        `,
        [uploadId, user.id]
      )

      const upload = result.rows[0]

      const reject = async (status, message) => {
        await client.query('ROLLBACK')
        transactionOpen = false

        return res.status(status).json({
          error: message
        })
      }

      if (!upload) {
        return await reject(404, 'Upload not found.')
      }

      const table = Object.hasOwn(COVER_TABLES, upload.kind)
        ? COVER_TABLES[upload.kind]
        : null

      if (!table) {
        return await reject(400, 'Unsupported upload kind.')
      }

      const targetResult = await client.query(
        `
          SELECT id, cover_key
          FROM ${table}
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [upload.target_id, user.id]
      )

      const target = targetResult.rows[0]

      if (!target) {
        return await reject(404, 'Beat or pack not found.')
      }

      if (upload.status === 'completed') {
        await client.query('ROLLBACK')
        transactionOpen = false

        return res.json({
          uploadId,
          completed: true,
          cover_url: uploadStorage.coverUrl(upload.final_key),
          isCurrentCover: target.cover_key === upload.final_key
        })
      }

      if (upload.status !== 'pending') {
        return await reject(
          409,
          'This upload cannot be completed in its current state.'
        )
      }

      if (upload.expired) {
        await client.query(
          `
            UPDATE account_uploads
            SET status = 'expired'
            WHERE id = $1
          `,
          [upload.id]
        )

        commitAttempted = true
        await client.query('COMMIT')
        transactionOpen = false

        return res.status(410).json({
          error: 'Upload expired. Choose the file again.'
        })
      }

      const expectedSize = Number(upload.expected_size)

      validateCoverDeclaration({
        contentType: upload.expected_content_type,
        size: expectedSize
      })

      const object = await uploadStorage.inspectTemporary(
        upload.temporary_key
      )

      if (
        object.size !== expectedSize ||
        object.contentType !== upload.expected_content_type ||
        !object.etag
      ) {
        throw new CoverValidationError(
          'The uploaded file does not match the authorized upload.'
        )
      }

      const buffer = await uploadStorage.readTemporary({
        key: upload.temporary_key,
        etag: object.etag,
        maxBytes: COVER_MAX_BYTES
      })

      const prepared = await prepareCover({
        buffer,
        contentType: upload.expected_content_type,
        expectedSize
      })

      const published = await uploadStorage.putCover({
        kind: upload.kind,
        userId: user.id,
        targetId: upload.target_id,
        webpBuffer: prepared.buffer
      })

      publishedKey = published.key

      await client.query(
        `
          UPDATE ${table}
          SET cover_key = $3
          WHERE id = $1
            AND user_id = $2
        `,
        [upload.target_id, user.id, published.key]
      )

      await client.query(
        `
          UPDATE account_uploads
          SET status = 'completed',
              final_key = $2,
              completed_at = NOW()
          WHERE id = $1
        `,
        [upload.id, published.key]
      )

      commitAttempted = true
      await client.query('COMMIT')
      transactionOpen = false

      return res.json({
        uploadId,
        completed: true,
        cover_url: published.url,
        isCurrentCover: true
      })
    } catch (error) {
      if (client && transactionOpen) {
        await client.query('ROLLBACK').catch(() => {})
      }

      // Se COMMIT foi tentado, sua resposta pode ter se perdido.
      // Não apagar um arquivo que talvez já esteja referenciado.
      if (publishedKey && !commitAttempted) {
        await uploadStorage
          .deleteCover(publishedKey)
          .catch(() => {
            console.error('Uncommitted cover cleanup failed.')
          })
      }

      if (error.code === '55P03') {
        return res.status(409).json({
          error: 'Upload completion is busy. Try again shortly.'
        })
      }

      if (error instanceof CoverValidationError) {
        return res.status(400).json({
          error: error.message
        })
      }

      if (
        error.name === 'NotFound' ||
        error.name === 'NoSuchKey' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        return res.status(409).json({
          error: 'File not found in storage. Finish the PUT upload first.'
        })
      }

      if (error.$metadata?.httpStatusCode === 412) {
        return res.status(409).json({
          error: 'The uploaded file changed. Try completing again.'
        })
      }

      console.error(
        'Complete upload failed:',
        error?.name || 'UnknownError'
      )

      return res.status(500).json({
        error: 'Unable to complete this upload. Try again.'
      })
    } finally {
      client?.release()
    }
  })
  
  return router
}
