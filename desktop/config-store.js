const fs = require('fs')
const path = require('path')
const schema = require('../app/config-schema')

function createConfigStore(getUserDataPath) {
  let cache = null
  let writeQueue = Promise.resolve()

  function filePath() { return path.join(getUserDataPath(), 'config.json') }
  function empty() { return { version: schema.version, updatedAt: null, data: {} } }
  function validKey(key) { return typeof key === 'string' && schema.keys.includes(key) }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const data = source.data && typeof source.data === 'object'
      ? source.data
      : (source.values && typeof source.values === 'object' ? source.values : {})
    return { version: schema.version, updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null, data }
  }

  function read() {
    if (cache) return cache
    try {
      cache = fs.existsSync(filePath()) ? normalize(JSON.parse(fs.readFileSync(filePath(), 'utf8'))) : empty()
    } catch (error) {
      console.warn('[fund-tracker] config read failed', error.message)
      cache = empty()
    }
    return cache
  }

  function encode(key, value) {
    if (!schema.jsonKeys.includes(key)) return String(value == null ? '' : value)
    if (typeof value !== 'string') return value
    try { return JSON.parse(value) } catch (_error) { return value }
  }

  function decode(key, value) {
    if (value === undefined || value === null) return null
    if (schema.jsonKeys.includes(key) && typeof value !== 'string') return JSON.stringify(value)
    return String(value)
  }

  async function persist() {
    const config = read()
    config.version = schema.version
    config.updatedAt = new Date().toISOString()
    const target = filePath()
    const temp = `${target}.tmp`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`)
    await fs.promises.rename(temp, target)
    return snapshot()
  }

  function enqueueWrite() {
    writeQueue = writeQueue.then(persist, persist)
    return writeQueue
  }

  function snapshot() {
    const data = {}
    Object.entries(read().data).forEach(([key, value]) => { if (validKey(key)) data[key] = decode(key, value) })
    return { version: schema.version, updatedAt: read().updatedAt, data }
  }

  function load() { return snapshot() }
  function patch(changes) {
    const data = read().data
    Object.entries(changes || {}).forEach(([key, value]) => {
      if (!validKey(key)) return
      if (value === null) delete data[key]
      else data[key] = encode(key, value)
    })
    return enqueueWrite()
  }
  function clear() { cache = empty(); return enqueueWrite() }

  return { clear, filePath, load, patch, schema }
}

module.exports = { createConfigStore }
