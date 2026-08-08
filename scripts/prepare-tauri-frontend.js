const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const output = path.join(root, '.tauri-frontend')

function copyTree(source, target, filter) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (filter && !filter(entry)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else fs.copyFileSync(from, to)
  }
}

fs.rmSync(output, { recursive: true, force: true })
copyTree(path.join(root, 'app'), output, (entry) => entry.name !== 'api')
copyTree(path.join(root, 'renderer'), path.join(output, 'renderer'))
