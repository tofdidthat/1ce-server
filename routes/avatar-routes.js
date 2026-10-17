import { Router } from 'express'
import multer from 'multer'

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter(request, file, callback) {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      callback(new Error('Use a JPEG, PNG or WebP image.'))
      return
    }

    callback(null, true)
  }
})

export function createAvatarRouter({
  db,
  getAccountFromRequest,
  avatarStorage,
  ready = () => true
}) {
  const router = Router()

  async function account(request, response) {
    response.setHeader('Cache-Control', 'no-store')

    if (!ready()) {
      response.status(503).json({
        error: 'Database is initializing. Try again shortly.'
      })

      return null
    }

    const user = await getAccountFromRequest(request)

    if (!user) {
      response.status(401).json({
        error: 'Sign in again to change your profile photo.'
      })
    }

    return user
  }

  async function readPictures(userId) {
    const result = await db.query(
      `
        SELECT
          picture,
          custom_picture
        FROM account_users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    )

    if (!result.rows.length) {
      return null
    }

    const row = result.rows[0]
    const customPicture = await avatarStorage.createAvatarUrl(row.custom_picture)

    return {
      googlePicture: row.picture || null,
      customPicture
    }
  }

  router.get('/me/avatar', async (request, response) => {
    try {
      const user = await account(request, response)

      if (!user) return

      const pictures = await readPictures(user.id)

      if (!pictures) {
        return response.status(404).json({ error: 'Account unavailable.' })
      }

      return response.json(pictures)
    } catch (error) {
      console.error('Read avatar error:', error)
      return response.status(500).json({ error: 'Unable to load your profile photo.' })
    }
  })

  router.post('/me/avatar', upload.single('avatar'), async (request, response) => {
    try {
      const user = await account(request, response)

      if (!user) return

      if (!request.file) {
        return response.status(400).json({ error: 'Choose an image to upload.' })
      }

      const previous = await db.query(
        'SELECT custom_picture FROM account_users WHERE id = $1 LIMIT 1',
        [user.id]
      )
      const previousKey = previous.rows[0]?.custom_picture || null
      const key = await avatarStorage.putAvatar(
        user.id,
        request.file.buffer,
        request.file.mimetype
      )

      await db.query(
        `
          UPDATE account_users
          SET custom_picture = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [user.id, key]
      )

      if (previousKey && previousKey !== key) {
        await avatarStorage.deleteAvatar(previousKey).catch(error => {
          console.error('Previous avatar cleanup error:', error)
        })
      }

      const pictures = await readPictures(user.id)

      return response.json(pictures)
    } catch (error) {
      if (error instanceof multer.MulterError) {
        const message = error.code === 'LIMIT_FILE_SIZE'
          ? 'Choose an image smaller than 5 MB.'
          : 'Unable to upload this image.'

        return response.status(400).json({ error: message })
      }

      if (error.message === 'Use a JPEG, PNG or WebP image.') {
        return response.status(400).json({ error: error.message })
      }

      console.error('Upload avatar error:', error)
      return response.status(500).json({ error: 'Unable to upload your profile photo.' })
    }
  })

  router.delete('/me/avatar', async (request, response) => {
    try {
      const user = await account(request, response)

      if (!user) return

      const current = await db.query(
        'SELECT custom_picture FROM account_users WHERE id = $1 LIMIT 1',
        [user.id]
      )
      const key = current.rows[0]?.custom_picture || null

      await db.query(
        `
          UPDATE account_users
          SET custom_picture = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [user.id]
      )

      if (key) {
        await avatarStorage.deleteAvatar(key).catch(error => {
          console.error('Avatar deletion error:', error)
        })
      }

      const pictures = await readPictures(user.id)

      return response.json(pictures)
    } catch (error) {
      console.error('Delete avatar error:', error)
      return response.status(500).json({ error: 'Unable to remove your profile photo.' })
    }
  })

  return router
}
