export function coverUrlFromKey(key) {
  if (!key) return null

  if (
    typeof key !== 'string' ||
    !/^(beats|packs)\//.test(key) ||
    key.includes('..')
  ) {
    throw new Error('Invalid cover key.')
  }

  const base = process.env.R2_COVERS_PUBLIC_BASE_URL

  if (!base) {
    throw new Error('R2 covers public URL is not configured.')
  }

  const url = new URL(base)

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid R2 covers public URL.')
  }

  const encodedKey = key
    .split('/')
    .map(encodeURIComponent)
    .join('/')

  return `${url.href.replace(/\/+$/, '')}/${encodedKey}`
}
