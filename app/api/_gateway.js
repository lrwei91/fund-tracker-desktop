// Process-wide provider scheduler, request coalescer and small TTL cache.
const providers = new Map()
const inflight = new Map()
const cache = new Map()

const DEFAULTS = {
  eastmoney: { concurrency: 1, minStartInterval: 1000, startJitter: 300 },
  tencent: { concurrency: 4, minStartInterval: 0 },
  default: { concurrency: 3, minStartInterval: 0 },
}

const EASTMONEY_CIRCUIT_MS = 5 * 60 * 1000

function providerState(name) {
  if (!providers.has(name)) providers.set(name, {
    active: 0,
    circuitUntil: 0,
    consecutiveFailures: 0,
    halfOpenProbe: false,
    lastError: '',
    lastStarted: 0,
    lastSuccess: 0,
    queue: [],
  })
  return providers.get(name)
}

function circuitError(name, until) {
  const error = new Error(`${name} 数据源熔断中`)
  error.code = 'PROVIDER_CIRCUIT_OPEN'
  error.circuitUntil = until
  return error
}

function enterProvider(name) {
  const state = providerState(name)
  if (name !== 'eastmoney' || !state.circuitUntil) return state
  if (state.circuitUntil > Date.now()) throw circuitError(name, state.circuitUntil)
  if (state.halfOpenProbe) throw circuitError(name, state.circuitUntil)
  state.halfOpenProbe = true
  return state
}

function isRetryableProviderError(error) {
  const status = Number(error && error.status)
  return !status || status === 429 || status >= 500
}

function providerSucceeded(name) {
  const state = providerState(name)
  state.consecutiveFailures = 0
  state.circuitUntil = 0
  state.halfOpenProbe = false
  state.lastError = ''
  state.lastSuccess = Date.now()
}

function providerFailed(name, error) {
  const state = providerState(name)
  state.halfOpenProbe = false
  state.lastError = error && error.message ? error.message : String(error || 'unknown error')
  if (name !== 'eastmoney') return
  if (error && error.code === 'PROVIDER_CIRCUIT_OPEN') return
  const status = Number(error && error.status)
  if (status === 403) state.consecutiveFailures = 3
  else if (isRetryableProviderError(error)) state.consecutiveFailures += 1
  else state.consecutiveFailures = 0
  if (state.consecutiveFailures >= 3) state.circuitUntil = Date.now() + EASTMONEY_CIRCUIT_MS
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
  if (name === 'eastmoney' && state.circuitUntil > Date.now()) {
    state.queue.shift()
    next.reject(circuitError(name, state.circuitUntil))
    drain(name)
    return
  }
  if (state.active >= next.rules.concurrency) return
  const targetInterval = next.rules.minStartInterval + Math.floor(Math.random() * ((next.rules.startJitter || 0) + 1))
  const delay = Math.max(0, targetInterval - (Date.now() - state.lastStarted))
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
  try {
    enterProvider(provider)
  } catch (error) {
    return Promise.reject(error)
  }
  const work = schedule(provider, loader, settings).then((value) => {
    providerSucceeded(provider)
    if (settings.cacheTtl > 0) {
      cache.set(cacheKey, { expiresAt: Date.now() + settings.cacheTtl, value })
      pruneCache(settings.maxEntries)
    }
    return value
  }, (error) => {
    providerFailed(provider, error)
    throw error
  })
  inflight.set(cacheKey, work)
  return work.finally(() => inflight.delete(cacheKey))
}

function diagnostics() {
  return {
    cacheEntries: cache.size,
    inflight: inflight.size,
    providers: Object.fromEntries(Array.from(providers.entries()).map(([name, state]) => [name, {
      active: state.active,
      circuitUntil: state.circuitUntil || null,
      lastError: state.lastError || null,
      lastSuccess: state.lastSuccess || null,
      queued: state.queue.length,
    }])),
  }
}

function reset() {
  providers.clear()
  inflight.clear()
  cache.clear()
}

module.exports = { diagnostics, request, reset }
