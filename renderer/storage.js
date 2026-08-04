(function () {
  var schema = window.AppConfigSchema || { keys: [] }
  var durable = new Set(schema.keys || [])
  var nativeStorage = window.localStorage
  var pending = {}
  var flushTimer = null

  function flush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    var changes = pending
    pending = {}
    var payload = changes
    return window.shell && window.shell.configStorage && typeof window.shell.configStorage.patch === 'function'
      ? window.shell.configStorage.patch(payload).catch(function () {})
      : Promise.resolve()
  }
  function schedule(key, value) {
    pending[key] = value
    if (!flushTimer) flushTimer = setTimeout(flush, 150)
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
      var data = snapshot && snapshot.data ? snapshot.data : {}
      Object.entries(data).forEach(function (entry) {
        if (durable.has(entry[0]) && entry[1] !== null) nativeStorage.setItem(entry[0], String(entry[1]))
      })
      var migration = {}
      durable.forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(data, key) && nativeStorage.getItem(key) !== null) migration[key] = nativeStorage.getItem(key)
      })
      if (Object.keys(migration).length) return window.shell.configStorage.patch(migration)
    }).catch(function () {})
  }
  window.AppStorage = { flush: flush, getItem: getItem, hydrate: hydrate, removeItem: removeItem, setItem: setItem }
  window.addEventListener('beforeunload', function () { flush() })
})()
