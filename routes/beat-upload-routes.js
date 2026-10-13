import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'

import { saveDesktopBeat } from '../beat-library.js'

export function createBeatUploadRouter({
  db,
  getAccountFromRequest,
  execFileAsync
}) {
  const router = Router()

  const upload = multer({
    storage: multer.diskStorage({}),
    limits: {
      fileSize: 200 * 1024 * 1024,
      files: 1,
      fields: 0,
      parts: 1
    }
  }).single('audio')

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

  router.post(
    '/me/beats',
    (req, res, next) => {
      upload(req, res, error => {
        if (!error) {
          next()
          return
        }

        return res.status(
          error.code === 'LIMIT_FILE_SIZE'
            ? 413
            : 400
        ).json({
          error:
            error.code === 'LIMIT_FILE_SIZE'
              ? 'Audio must be at most 200 MB.'
              : 'Invalid audio upload.'
        })
      })
    },
    async (req, res) => {
      const file = req.file

      try {
        const account =
          await requireAccount(req, res)

        if (!account) return

        if (!file) {
          return res.status(400).json({
            error: 'MP3 audio is required.'
          })
        }

        const result = await execFileAsync(
          'ffprobe',
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            file.path
          ],
          {
            timeout: 15000,
            maxBuffer: 1024 * 1024
          }
        )

        const info = JSON.parse(result.stdout)

        const validMp3 =
          info.format?.format_name === 'mp3' &&
          info.streams?.some(
            stream =>
              stream.codec_type === 'audio' &&
              stream.codec_name === 'mp3'
          )

        if (!validMp3) {
          return res.status(400).json({
            error: 'Audio must be MP3.'
          })
        }

        const beat = await saveDesktopBeat(
          db,
          account.id,
          file,
          info.format?.duration
        )

        return res.status(201).json({
          beat
        })
      } catch (error) {
        console.error('Web beat upload error:', error)

        return res.status(500).json({
          error: 'Unable to save this beat.'
        })
      } finally {
        if (file?.path) {
          fs.unlink(file.path, () => {})
        }
      }
    }
  )

  return router
}
