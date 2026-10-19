export function createUploadLimits({
  maxAccounts = 10000,
  maxConcurrent = 2,
  windowMs = 60_000
} = {}) {
  const accounts = new Map()
  let running = 0

  function consume(userId, action, limit) {
    const now = Date.now()
    const key = `${userId}:${action}`

    let entry = accounts.get(key)

    if (!entry || entry.resetAt <= now) {
      if (!entry && accounts.size >= maxAccounts) {
        for (const [storedKey, value] of accounts) {
          if (value.resetAt <= now) {
            accounts.delete(storedKey)
          }
        }

        if (accounts.size >= maxAccounts) {
          return {
            allowed: false,
            retryAfter: Math.ceil(windowMs / 1000)
          }
        }
      }

      entry = {
        count: 0,
        resetAt: now + windowMs
      }

      accounts.set(key, entry)
    }

    if (entry.count >= limit) {
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((entry.resetAt - now) / 1000)
        )
      }
    }

    entry.count += 1

    return {
      allowed: true,
      retryAfter: 0
    }
  }

  function acquire() {
    if (running >= maxConcurrent) {
      return null
    }

    running += 1
    let released = false

    return () => {
      if (released) return

      released = true
      running -= 1
    }
  }

  return {
    consume,
    acquire
  }
}
