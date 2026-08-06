const fs = require('fs')
const path = require('path')

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': MIME['.json'] } })
}

function createMemoryResponse() {
  const chunks = []
  const headers = new Map()
  return {
    statusCode: 200,
    setHeader(name, value) { headers.set(String(name), String(value)) },
    getHeader(name) { return headers.get(String(name)) },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''))) },
    end(chunk) { if (chunk !== undefined) this.write(chunk) },
    toResponse() {
      if (!headers.has('Content-Type')) headers.set('Content-Type', MIME['.json'])
      return new Response(Buffer.concat(chunks), { status: this.statusCode || 200, headers: Object.fromEntries(headers) })
    },
  }
}

function registerProtocol({ app, appRoot, protocol, rendererRoot }) {
  async function handleApi(pathname, searchParams) {
    const apiName = pathname.replace(/^\/api\//, '').replace(/\.js$/, '')
    if (!/^[a-z0-9-]+$/i.test(apiName)) return jsonResponse(404, { success: false, message: 'API not found' })
    const apiRoot = path.join(appRoot, 'api')
    const handlerPath = path.join(apiRoot, `${apiName}.js`)
    if (!isInside(apiRoot, handlerPath) || !fs.existsSync(handlerPath)) return jsonResponse(404, { success: false, message: 'API not found' })
    try {
      if (!app.isPackaged) delete require.cache[require.resolve(handlerPath)]
      const handler = require(handlerPath)
      const response = createMemoryResponse()
      await Promise.resolve(handler({ query: Object.fromEntries(searchParams.entries()) }, response))
      return response.toResponse()
    } catch (error) {
      return jsonResponse(500, { success: false, message: error.message || 'API failed' })
    }
  }

  async function staticResponse(root, pathname) {
    const requestPath = pathname === '/' ? '/index.html' : pathname
    const filePath = path.normalize(path.join(root, requestPath))
    if ((!isInside(root, filePath) && filePath !== path.join(root, 'index.html')) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(await fs.promises.readFile(filePath), {
      status: 200, headers: { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' },
    })
  }

  protocol.handle('fund-tracker', async (request) => {
    try {
      const url = new URL(request.url)
      const pathname = decodeURIComponent(url.pathname)
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
      if (pathname.startsWith('/api/')) return handleApi(pathname, url.searchParams)
      if (pathname.startsWith('/renderer/')) return staticResponse(rendererRoot, pathname.replace(/^\/renderer/, '') || '/holding-widget.html')
      return staticResponse(appRoot, pathname)
    } catch (error) {
      return jsonResponse(500, { success: false, message: error.message || 'Protocol failed' })
    }
  })
}

module.exports = { registerProtocol }
