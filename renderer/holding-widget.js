(function () {
  var SWITCH_MS = 5000
  var WATCH_TABS_KEY = 'fund_tracker_watchlist_tabs'
  var LEGACY_WATCHLIST_KEY = 'fund_tracker_watchlist'
  var QUOTE_CACHE_KEY = 'fund_tracker_watch_quote_cache'
  var REMARKS_KEY = 'fund_tracker_watchlist_remarks'
  var SETTINGS_KEY = 'fund_tracker_settings'
  var CLOWN_MODE_KEY = 'fund_tracker_holding_clown_mode'

  var slot = document.getElementById('quote-slot')
  var shell = document.getElementById('widget-shell')
  var clownModeBtn = document.getElementById('clown-mode-btn')
  var index = 0
  var currentCode = null
  var timer = null
  var animationTimer = null
  var clownMode = window.AppStorage.getItem(CLOWN_MODE_KEY) === 'true'

  function readJson(key, fallback) {
    try {
      var raw = window.AppStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch (e) {
      return fallback
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function sanitizeCodes(codes) {
    return Array.isArray(codes)
      ? codes.filter(function (code, itemIndex, arr) {
        return /^\d{6}$/.test(code) && arr.indexOf(code) === itemIndex
      })
      : []
  }

  function getHoldingCodes() {
    var tabs = readJson(WATCH_TABS_KEY, null)
    if (Array.isArray(tabs)) {
      var holding = tabs.find(function (tab) { return tab && tab.id === 'default' }) || tabs[0]
      return sanitizeCodes(holding && holding.codes)
    }
    return sanitizeCodes(readJson(LEGACY_WATCHLIST_KEY, []))
  }

  function formatPct(value) {
    var number = Number(value)
    if (!Number.isFinite(number)) number = 0
    return (number > 0 ? '+' : '') + number.toFixed(2) + '%'
  }

  function quoteClass(value) {
    var number = Number(value)
    if (number > 0) return 'positive'
    if (number < 0) return 'negative'
    return 'neutral'
  }

  function readNumber(value) {
    var number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function getLimitRate(code) {
    return /^(300|301)/.test(String(code || '')) ? 20 : 10
  }

  function getPreviousClose(quote) {
    if (!quote) return null
    var price = readNumber(quote.priceValue != null ? quote.priceValue : quote.price)
    if (price === null || price <= 0) return null

    var change = readNumber(quote.change)
    if (change !== null) {
      var prevFromChange = price - change
      if (Number.isFinite(prevFromChange) && prevFromChange > 0) return prevFromChange
    }

    var pct = readNumber(quote.changePercent)
    if (pct !== null && pct > -100) {
      var prevFromPct = price / (1 + pct / 100)
      if (Number.isFinite(prevFromPct) && prevFromPct > 0) return prevFromPct
    }

    return null
  }

  function formatPrice(value) {
    if (!Number.isFinite(value) || value <= 0) return '--'
    return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2)
  }

  function getDisplayName(code, quote, remarks) {
    var remark = remarks && remarks[code] ? String(remarks[code]).trim() : ''
    if (remark) return remark
    return quote && quote.name ? quote.name : code + '（待刷新）'
  }

  function getDisplayQuote(code, quote, remarks) {
    var rate = getLimitRate(code)
    var name = getDisplayName(code, quote, remarks)
    if (!clownMode) {
      return {
        name: name,
        price: quote && quote.price ? quote.price : '--',
        pct: quote && typeof quote.changePercent === 'number' ? quote.changePercent : 0,
      }
    }

    var prevClose = getPreviousClose(quote)
    return {
      name: name,
      price: prevClose === null ? '--' : formatPrice(prevClose * (1 + rate / 100)),
      pct: rate,
    }
  }

  function updateClownButton() {
    if (!clownModeBtn) return
    clownModeBtn.classList.toggle('active', clownMode)
    clownModeBtn.setAttribute('aria-pressed', clownMode ? 'true' : 'false')
    clownModeBtn.title = clownMode ? '关闭小丑模式' : '小丑模式'
    clownModeBtn.setAttribute('aria-label', clownMode ? '关闭小丑模式' : '小丑模式')
  }

  function readSettings() {
    var settings = readJson(SETTINGS_KEY, {})
    var opacity = Number(settings.holdingOpacity)
    if (!Number.isFinite(opacity)) opacity = 100
    return {
      colorMode: settings.holdingColorMode === 'white' ? 'white' : 'market',
      opacity: Math.max(0, Math.min(100, Math.round(opacity))),
    }
  }

  function applySettings() {
    var settings = readSettings()
    shell.classList.toggle('white-mode', settings.colorMode === 'white')
    shell.style.setProperty('--holding-opacity', String(settings.opacity / 100))
  }

  function stopQuoteAnimation() {
    if (animationTimer) {
      clearTimeout(animationTimer)
      animationTimer = null
    }
    slot.classList.remove('quote-switching')
  }

  function restartQuoteAnimation() {
    stopQuoteAnimation()
    void slot.offsetWidth
    slot.classList.add('quote-switching')
    animationTimer = setTimeout(stopQuoteAnimation, 240)
  }

  function clearSwitchTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleNextSwitch() {
    clearSwitchTimer()
    timer = setTimeout(function () {
      timer = null
      syncSwitchTimer(render({ advance: true }), true)
    }, SWITCH_MS)
  }

  function syncSwitchTimer(result, restart) {
    if (!result || result.codesLength <= 1) {
      clearSwitchTimer()
      return
    }
    if (restart || !timer) scheduleNextSwitch()
  }

  function render(options) {
    options = options || {}
    var advance = Boolean(options.advance)
    var stayOnCurrent = Boolean(options.stayOnCurrent)
    var reset = Boolean(options.reset)
    applySettings()
    updateClownButton()
    var codes = getHoldingCodes()
    var cache = readJson(QUOTE_CACHE_KEY, {})
    var remarks = readJson(REMARKS_KEY, {})

    if (!codes.length) {
      var hadCode = currentCode !== null
      stopQuoteAnimation()
      slot.innerHTML = '<div class="quote-empty">暂无持仓股</div>'
      index = 0
      currentCode = null
      return { codesLength: 0, switched: hadCode }
    }

    if (reset) {
      index = 0
      currentCode = null
    }
    if (index >= codes.length) index = 0
    var previousCode = currentCode
    var code = (stayOnCurrent || !advance) && currentCode && codes.indexOf(currentCode) !== -1
      ? currentCode
      : codes[index]
    var shouldAnimate = previousCode !== null && previousCode !== code
    currentCode = code
    var quote = cache && cache[code] ? cache[code] : null
    var displayQuote = getDisplayQuote(code, quote, remarks)
    var pct = displayQuote.pct
    var cls = quoteClass(pct)

    if (!shouldAnimate) stopQuoteAnimation()
    slot.innerHTML = [
      '<div class="quote-main">',
      '<div class="quote-name">', escapeHtml(displayQuote.name), '</div>',
      '<div class="quote-code">', escapeHtml(code), '</div>',
      '</div>',
      '<div class="quote-price ', cls, '">', escapeHtml(displayQuote.price), '</div>',
      '<div class="quote-change ', cls, '">', escapeHtml(formatPct(pct)), '</div>',
    ].join('')
    if (shouldAnimate) restartQuoteAnimation()

    var shownIndex = codes.indexOf(code)
    if (shownIndex === -1) shownIndex = 0
    index = (shownIndex + 1) % codes.length
    return {
      codesLength: codes.length,
      switched: previousCode !== code,
    }
  }

  function bindControls() {
    if (clownModeBtn) {
      clownModeBtn.addEventListener('click', function () {
        clownMode = !clownMode
        try { window.AppStorage.setItem(CLOWN_MODE_KEY, clownMode ? 'true' : 'false') } catch (e) {}
        syncSwitchTimer(render({ stayOnCurrent: true }), false)
      })
    }
    document.getElementById('minimize-btn').addEventListener('click', function () {
      if (window.shell && window.shell.minimizeHoldingWindow) window.shell.minimizeHoldingWindow()
    })
    document.getElementById('maximize-btn').addEventListener('click', function () {
      if (window.shell && window.shell.maximizeHoldingWindow) window.shell.maximizeHoldingWindow()
    })
    document.getElementById('close-btn').addEventListener('click', function () {
      if (window.shell && window.shell.closeHoldingWindow) window.shell.closeHoldingWindow()
    })
  }

  function renderAfterStorageChange(event) {
    if (!event || event.key === WATCH_TABS_KEY || event.key === LEGACY_WATCHLIST_KEY) {
      var codes = getHoldingCodes()
      var result = render({
        reset: !currentCode || codes.indexOf(currentCode) === -1,
        stayOnCurrent: !!currentCode && codes.indexOf(currentCode) !== -1,
      })
      syncSwitchTimer(result, result && result.switched)
      return
    }

    if ([QUOTE_CACHE_KEY, REMARKS_KEY, SETTINGS_KEY, CLOWN_MODE_KEY].indexOf(event.key) !== -1) {
      if (event.key === CLOWN_MODE_KEY) clownMode = window.AppStorage.getItem(CLOWN_MODE_KEY) === 'true'
      var refreshResult = render({ stayOnCurrent: true })
      syncSwitchTimer(refreshResult, refreshResult && refreshResult.switched)
    }
  }

  window.addEventListener('storage', renderAfterStorageChange)
  bindControls()
  syncSwitchTimer(render({ reset: true }), true)

  if (window.AppStorage && typeof window.AppStorage.hydrate === 'function') {
    window.AppStorage.hydrate().then(function () {
      clownMode = window.AppStorage.getItem(CLOWN_MODE_KEY) === 'true'
      var result = render({ reset: true })
      syncSwitchTimer(result, true)
    })
  }

  if (window.shell && window.shell.onHoldingWidgetRefresh) {
    window.shell.onHoldingWidgetRefresh(function () {
      var result = render({ stayOnCurrent: true })
      syncSwitchTimer(result, result && result.switched)
    })
  }
})()
