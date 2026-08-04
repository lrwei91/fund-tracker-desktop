let capability = 'unknown'

function explicitlyConfigured() {
  return Boolean(process.env.TDXRS_BIN || process.env.TDXRS_PYTHON)
}

function isPackagedRuntime() {
  return Boolean(process.versions && process.versions.electron && !process.defaultApp)
}

function shouldTry() {
  if (explicitlyConfigured()) return true
  if (isPackagedRuntime()) return false
  return capability !== 'unavailable'
}

function markAvailable() { capability = 'available' }
function markUnavailable() { capability = 'unavailable' }
function status() { return capability }
function reset() { capability = 'unknown' }

module.exports = { explicitlyConfigured, markAvailable, markUnavailable, reset, shouldTry, status }
