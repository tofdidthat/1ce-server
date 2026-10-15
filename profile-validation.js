const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateProfileInput(body) {
  if (!body || !Array.isArray(body.beatIds) || body.beatIds.length > 200) {
    throw new Error('Select up to 200 beats.')
  }
  if (!Number.isSafeInteger(body.version) || body.version < 0) {
    throw new Error('Invalid profile version. Reload the editor.')
  }
  const beatIds = body.beatIds.map(id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid beat ID.')
    return id.toLowerCase()
  })
  if (new Set(beatIds).size !== beatIds.length) throw new Error('Duplicate beats are not allowed.')
  if (!Array.isArray(body.links) || body.links.length > 10) throw new Error('Add up to 10 links.')
  const links = body.links.map(link => {
    if (!link || typeof link.label !== 'string' || typeof link.url !== 'string') {
      throw new Error('Each link needs a label and URL.')
    }
    const label = link.label.trim()
    const raw = link.url.trim()
    if (!label || label.length > 60 || !raw || raw.length > 2048) {
      throw new Error('Use a label of 1–60 characters and a URL of up to 2048 characters.')
    }
    let url
    try { url = new URL(raw) } catch { throw new Error('Enter a complete link beginning with https:// or http://.') }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error('Only http:// and https:// links without embedded credentials are allowed.')
    }
    return { label, url: url.href }
  })
  if (new Set(links.map(link => link.url)).size !== links.length) throw new Error('Duplicate links are not allowed.')
  return { beatIds, links, version: body.version }
}
