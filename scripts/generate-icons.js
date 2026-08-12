const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const source = path.join(root, 'brand', 'app-icon-1024.png')
const output = path.join(root, 'build')
const appAsset = path.join(root, 'app', 'assets', 'app-icon.png')
const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-tracker-icons-'))

try {
  execFileSync(process.execPath, [tauriCli, 'icon', source, '--output', temp], { stdio: 'inherit' })
  fs.mkdirSync(output, { recursive: true })
  for (const name of ['icon.png', 'icon.icns', 'icon.ico']) {
    const target = path.join(output, name)
    fs.copyFileSync(path.join(temp, name), target)
    fs.chmodSync(target, 0o644)
  }
  fs.mkdirSync(path.dirname(appAsset), { recursive: true })
  fs.copyFileSync(path.join(temp, '128x128.png'), appAsset)
  fs.chmodSync(appAsset, 0o644)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
