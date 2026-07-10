// Process-wide provider scheduler, request coalescer and small TTL cache.
const providers = new Map()
const inflight = new Map()
const cache = new Map()

const DEFAULTS = {
  eastmoney: { concurrency: 2, minStartInterval: 250 },
  tencent: { concurrency: 4, minStartInterval: 0 },
  default: { concurrency: 3, minStartInterval: 0 },
}

function providerState(name) {
  if (!providers.has(name)) providers.set(name, { active: 0, lastStarted: 0, queue: [] })
  return providers.get(name)
}

function schedule(name, task, options) {
  const state = providerState(name)
  const rules = Object.assign({}, DEFAULTS.default, DEFAULTS[name] || {}, options || {})
  return new Promise((resolve, reject) => {
    state.queue.push({ reject, resolve, task, rules })
    drain(name)
  })
}

function drain(name) {
  const state = providerState(name)
  if (!state.queue.length) return
  const next = state.queue[0]
  if (state.active >= next.rules.concurrency) return
  const delay = Math.max(0, next.rules.minStartInterval - (Date.now() - state.lastStarted))
  if (delay) {
    setTimeout(() => drain(name), delay)
    return
  }
  state.queue.shift()
  state.active += 1
  state.lastStarted = Date.now()
  Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => {
    state.active -= 1
    drain(name)
  })
}

function pruneCache(maxEntries) {
  const now = Date.now()
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key)
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
}

function request(provider, key, loader, options) {
  const settings = Object.assign({ cacheTtl: 0, maxEntries: 200 }, options || {})
  const cacheKey = `${provider}:${key}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)
  const work = schedule(provider, loader, settings).then((value) => {
    if (settings.cacheTtl > 0) {
      cache.set(cacheKey, { expiresAt: Date.now() + settings.cacheTtl, value })
      pruneCache(settings.maxEntries)
    }
    return value
  })
  inflight.set(cacheKey, work)
  return work.finally(() => inflight.delete(cacheKey))
}

function diagnostics() {
  return {
    cacheEntries: cache.size,
    inflight: inflight.size,
    providers: Object.fromEntries(Array.from(providers.entries()).map(([name, state]) => [name, {
      active: state.active, queued: state.queue.length,
    }])),
  }
}

module.exports = { diagnostics, request }
