import { randomUUID } from 'node:crypto'
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export function createUploadStorage() {
  let client

  function config() {
    const {
      R2_ACCOUNT_ID: accountId,
      R2_ACCESS_KEY_ID: accessKeyId,
      R2_SECRET_ACCESS_KEY: secretAccessKey,
      R2_UPLOADS_BUCKET: uploadsBucket,
      R2_COVERS_BUCKET: coversBucket,
      R2_COVERS_PUBLIC_BASE_URL: publicBase
    } = process.env

    if (
      !accountId ||
      !accessKeyId ||
      !secretAccessKey ||
      !uploadsBucket ||
      !coversBucket ||
      !publicBase
    ) {
      throw new Error('R2 upload storage is not configured.')
    }

    const publicUrl = new URL(publicBase)

    if (
      publicUrl.protocol !== 'https:' ||
      publicUrl.search ||
      publicUrl.hash ||
      publicUrl.username ||
      publicUrl.password
    ) {
      throw new Error('Invalid R2 covers public URL.')
    }

    client ||= new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    })

    return {
      client,
      uploadsBucket,
      coversBucket,
      publicBase: publicUrl.href.replace(/\/+$/, '')
    }
  }

  function checkTemporaryKey(key) {
    if (
      typeof key !== 'string' ||
      !key.startsWith('pending/') ||
      key.includes('..')
    ) {
      throw new Error('Invalid temporary object key.')
    }
  }

  function checkCoverKey(key) {
    if (
      typeof key !== 'string' ||
      !/^(beats|packs)\//.test(key) ||
      key.includes('..')
    ) {
      throw new Error('Invalid cover object key.')
    }
  }

  async function createUploadUrl({
    userId,
    uploadId,
    contentType
  }) {
    const {
      client: s3,
      uploadsBucket
    } = config()

    const key = `pending/${userId}/${uploadId}`

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: uploadsBucket,
        Key: key,
        ContentType: contentType
      }),
      { expiresIn: 300 }
    )

    return {
      key,
      uploadUrl,
      expiresIn: 300,
      headers: {
        'Content-Type': contentType
      }
    }
  }

  async function inspectTemporary(key) {
    checkTemporaryKey(key)

    const {
      client: s3,
      uploadsBucket
    } = config()

    const result = await s3.send(
      new HeadObjectCommand({
        Bucket: uploadsBucket,
        Key: key
      })
    )

    return {
      size: result.ContentLength,
      contentType: result.ContentType,
      etag: result.ETag
    }
  }

  async function readTemporary({
    key,
    etag,
    maxBytes
  }) {
    checkTemporaryKey(key)

    if (!etag || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Invalid temporary object read.')
    }

    const {
      client: s3,
      uploadsBucket
    } = config()

    const result = await s3.send(
      new GetObjectCommand({
        Bucket: uploadsBucket,
        Key: key,
        IfMatch: etag
      })
    )

    const chunks = []
    let total = 0

    try {
      for await (const chunk of result.Body) {
        const buffer = Buffer.from(chunk)
        total += buffer.length

        if (total > maxBytes) {
          throw new Error('Uploaded file exceeds the size limit.')
        }

        chunks.push(buffer)
      }
    } finally {
      result.Body?.destroy?.()
    }

    return Buffer.concat(chunks, total)
  }

  async function putCover({
    kind,
    userId,
    targetId,
    webpBuffer
  }) {
    if (!['beat-cover', 'pack-cover'].includes(kind)) {
      throw new Error('Unsupported cover kind.')
    }

    if (!Buffer.isBuffer(webpBuffer) || !webpBuffer.length) {
      throw new Error('Empty cover image.')
    }

    const {
      client: s3,
      coversBucket,
      publicBase
    } = config()

    const prefix = kind === 'beat-cover' ? 'beats' : 'packs'

    const key =
      `${prefix}/${userId}/${targetId}/${randomUUID()}.webp`

    await s3.send(
      new PutObjectCommand({
        Bucket: coversBucket,
        Key: key,
        Body: webpBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable'
      })
    )

    return {
      key,
      url: `${publicBase}/${key}`
    }
  }

  function coverUrl(key) {
    if (!key) return null

    checkCoverKey(key)

    return `${config().publicBase}/${key}`
  }

  async function deleteTemporary(key) {
    checkTemporaryKey(key)

    const {
      client: s3,
      uploadsBucket
    } = config()

    await s3.send(
      new DeleteObjectCommand({
        Bucket: uploadsBucket,
        Key: key
      })
    )
  }

  async function deleteCover(key) {
    if (!key) return

    checkCoverKey(key)

    const {
      client: s3,
      coversBucket
    } = config()

    await s3.send(
      new DeleteObjectCommand({
        Bucket: coversBucket,
        Key: key
      })
    )
  }

  return {
    createUploadUrl,
    inspectTemporary,
    readTemporary,
    putCover,
    coverUrl,
    deleteTemporary,
    deleteCover
  }
}
