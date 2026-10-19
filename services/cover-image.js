import sharp from 'sharp'

export const COVER_MAX_BYTES = 5 * 1024 * 1024
export const COVER_MAX_PIXELS = 20_000_000
export const COVER_OUTPUT_SIZE = 1200

const ALLOWED_FORMATS = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
])

export class CoverValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CoverValidationError'
    this.statusCode = 400
  }
}

export function validateCoverDeclaration({
  contentType,
  size
}) {
  if (!ALLOWED_FORMATS.has(contentType)) {
    throw new CoverValidationError(
      'Use a JPEG, PNG or WebP image.'
    )
  }

  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > COVER_MAX_BYTES
  ) {
    throw new CoverValidationError(
      'Choose an image no larger than 5 MB.'
    )
  }
}

export async function prepareCover({
  buffer,
  contentType,
  expectedSize
}) {
  validateCoverDeclaration({
    contentType,
    size: expectedSize
  })

  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length !== expectedSize ||
    buffer.length > COVER_MAX_BYTES
  ) {
    throw new CoverValidationError(
      'The uploaded file size does not match the authorized upload.'
    )
  }

  let image

  try {
    image = sharp(buffer, {
      failOn: 'warning',
      limitInputPixels: COVER_MAX_PIXELS,
      sequentialRead: true
    })

    const metadata = await image.metadata()

    if (
      metadata.format !== ALLOWED_FORMATS.get(contentType)
    ) {
      throw new CoverValidationError(
        'The image content does not match its declared format.'
      )
    }

    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > COVER_MAX_PIXELS
    ) {
      throw new CoverValidationError(
        'Choose an image with no more than 20 megapixels.'
      )
    }

    if ((metadata.pages || 1) > 1) {
      throw new CoverValidationError(
        'Animated or multi-page images are not supported.'
      )
    }

    const result = await image
      .rotate()
      .resize({
        width: COVER_OUTPUT_SIZE,
        height: COVER_OUTPUT_SIZE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({
        quality: 85,
        effort: 4
      })
      .toBuffer({ resolveWithObject: true })

    if (
      !result.data.length ||
      result.data.length > COVER_MAX_BYTES
    ) {
      throw new CoverValidationError(
        'Unable to produce a cover within the size limit.'
      )
    }

    return {
      buffer: result.data,
      contentType: 'image/webp',
      size: result.data.length,
      width: result.info.width,
      height: result.info.height
    }
  } catch (error) {
    if (error instanceof CoverValidationError) {
      throw error
    }

    throw new CoverValidationError(
      'Unable to process this image. Use a valid JPEG, PNG or WebP file.'
    )
  } finally {
    image?.destroy()
  }
}
