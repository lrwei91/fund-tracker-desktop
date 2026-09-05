(function () {
  var schema = window.AppConfigSchema || { keys: [] }
  var durable = new Set(schema.keys || [])
  var nativeStorage = window.localStorage
  var pending = {}
  var flushTimer = null
  var flushPromise = null
  var status = { state: 'idle', pending: 0, error: null }

  function emitStatus(nextState, error) {
    status = { state: nextState, pending: Object.keys(pending).length, error: error || null }
    document.dispatchEvent(new CustomEvent('fund-tracker-storage-status', { detail: Object.assign({}, status) }))
  }

  function flush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    if (flushPromise) return flushPromise
    var payload = pending
    if (!Object.keys(payload).length) return Promise.resolve()
    pending = {}
    if (!window.shell || !window.shell.configStorage || typeof window.shell.configStorage.patch !== 'function') {
      emitStatus('saved')
      return Promise.resolve()
    }
    emitStatus('saving')
    var succeeded = false
    flushPromise = Promise.resolve().then(function () {
      return window.shell.configStorage.patch(payload)
    }).then(function () {
      succeeded = true
      emitStatus(Object.keys(pending).length ? 'unsaved' : 'saved')
    }).catch(function (error) {
      Object.keys(payload).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(pending, key)) pending[key] = payload[key]
      })
      emitStatus('error', error && error.message ? error.message : String(error))
      throw error
    }).finally(function () {
      flushPromise = null
      if (succeeded && Object.keys(pending).length && !flushTimer) flushTimer = setTimeout(function () { flush().catch(function () {}) }, 150)
    })
    return flushPromise
  }
  function schedule(key, value) {
    pending[key] = value
    emitStatus('unsaved')
    if (!flushTimer) flushTimer = setTimeout(function () { flush().catch(function () {}) }, 150)
  }
  function getItem(key) { return nativeStorage.getItem(String(key)) }
  function setItem(key, value) {
    nativeStorage.setItem(String(key), String(value))
    if (durable.has(String(key))) schedule(String(key), String(value))
  }
  function removeItem(key) {
    nativeStorage.removeItem(String(key))
    if (durable.has(String(key))) schedule(String(key), null)
  }
  function hydrate() {
    if (!window.shell || !window.shell.configStorage || typeof window.shell.configStorage.load !== 'function') return Promise.resolve()
    return window.shell.configStorage.load().then(function (snapshot) {
      if (snapshot && snapshot.configError) emitStatus('error', snapshot.configError.message || snapshot.configError)
      var data = snapshot && snapshot.data ? snapshot.data : {}
      Object.entries(data).forEach(function (entry) {
        if (durable.has(entry[0]) && entry[1] !== null) nativeStorage.setItem(entry[0], String(entry[1]))
      })
      var migration = {}
      durable.forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(data, key) && nativeStorage.getItem(key) !== null) migration[key] = nativeStorage.getItem(key)
      })
      if (Object.keys(migration).length) {
        Object.keys(migration).forEach(function (key) { pending[key] = migration[key] })
        return flush().catch(function () {})
      }
    }).catch(function (error) {
      emitStatus('error', error && error.message ? error.message : String(error))
    })
  }
  function commit(changes) {
    var payload = Object.assign({}, changes || {})
    function apply() {
      Object.keys(payload).forEach(function (key) {
        if (payload[key] === null) nativeStorage.removeItem(key)
        else nativeStorage.setItem(key, String(payload[key]))
      })
      emitStatus('saved')
    }
    return flush().then(function () {
      if (!window.shell || !window.shell.configStorage || typeof window.shell.configStorage.patch !== 'function') {
        apply()
        return
      }
      emitStatus('saving')
      return Promise.resolve().then(function () { return window.shell.configStorage.patch(payload) }).then(apply).catch(function (error) {
        Object.keys(payload).forEach(function (key) {
          if (!Object.prototype.hasOwnProperty.call(pending, key)) pending[key] = payload[key]
        })
        emitStatus('error', error && error.message ? error.message : String(error))
        throw error
      })
    })
  }
  window.AppStorage = { commit: commit, flush: flush, getItem: getItem, getStatus: function () { return Object.assign({}, status) }, hydrate: hydrate, removeItem: removeItem, setItem: setItem }
  window.addEventListener('beforeunload', function () { flush() })
})()
