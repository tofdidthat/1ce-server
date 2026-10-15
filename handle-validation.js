const RESERVED = new Set(['admin', 'administrator', 'support', 'help', 'system', 'official', '1ce', 'account', 'login', 'signup', 'api', 'app', 'profile', 'privacy', 'terms'])
export function normalizeHandle(value) {
  if (typeof value !== 'string') throw new Error('Enter a username.')
  const handle = value.trim().replace(/^@/, '').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._]{1,22}[a-z0-9]$/.test(handle) || handle.includes('..')) {
    throw new Error('Use 3–24 characters: letters, numbers, periods or underscores. Start and end with a letter or number.')
  }
  if (RESERVED.has(handle)) throw new Error('This username is reserved. Choose another.')
  return handle
}
