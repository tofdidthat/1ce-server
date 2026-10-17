import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}

export function createAvatarStorage() {
  let client = null
  let bucket = null

  function configure() {
    const accountId = process.env.R2_ACCOUNT_ID
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
    bucket = process.env.R2_BUCKET

    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('R2 avatar storage is not configured.')
    }

    client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }
    })
  }

  function ensureConfigured() {
    if (!client || !bucket) configure()
    return { client, bucket }
  }

  function extensionFor(contentType) {
    return CONTENT_TYPES[String(contentType || '').toLowerCase()] || null
  }

  async function putAvatar(userId, buffer, contentType) {
    const { client: s3, bucket: targetBucket } = ensureConfigured()
    const extension = extensionFor(contentType)

    if (!extension) {
      throw new Error('Unsupported image type.')
    }

    const key = `avatars/${userId}/profile-${Date.now()}.${extension}`

    await s3.send(new PutObjectCommand({
      Bucket: targetBucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable'
    }))

    return key
  }

  async function deleteAvatar(key) {
    if (!key) return

    const { client: s3, bucket: targetBucket } = ensureConfigured()

    await s3.send(new DeleteObjectCommand({
      Bucket: targetBucket,
      Key: key
    }))
  }

  async function createAvatarUrl(key) {
    if (!key) return null

    const { client: s3, bucket: targetBucket } = ensureConfigured()

    return getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: targetBucket,
        Key: key
      }),
      { expiresIn: 604800 }
    )
  }

  return {
    putAvatar,
    deleteAvatar,
    createAvatarUrl
  }
}
