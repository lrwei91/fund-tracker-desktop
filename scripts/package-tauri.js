const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')
const pkg = require('../package.json')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const target = path.join(root, 'src-tauri', 'target', 'release')
const platform = process.argv[2]
fs.mkdirSync(dist, { recursive: true })

function ensureValidMacSignature(source) {
  const verifyArgs = ['--verify', '--deep', '--strict', source]
  try {
    execFileSync('/usr/bin/codesign', verifyArgs, { stdio: 'pipe' })
  } catch {
    process.stdout.write('macOS app 签名不完整，应用临时签名后重新校验\n')
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', source], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', verifyArgs, { stdio: 'inherit' })
  }
}

if (platform === 'mac') {
  const source = path.join(target, 'bundle', 'macos', '恭喜发财.app')
  const output = path.join(dist, `fund-tracker-${pkg.version}-mac-arm64.zip`)
  // A watched Documents/build directory can regain FinderInfo while codesign
  // runs. Sign a clean staging copy and omit resource metadata from the ZIP.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-tracker-package-'))
  try {
    const stagedApp = path.join(stage, '恭喜发财.app')
    execFileSync('/usr/bin/ditto', ['--norsrc', '--noextattr', source, stagedApp])
    ensureValidMacSignature(stagedApp)
    fs.rmSync(output, { force: true })
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', stagedApp, output])
    const verification = path.join(stage, 'verify')
    execFileSync('/usr/bin/ditto', ['-x', '-k', output, verification])
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(verification, '恭喜发财.app')], { stdio: 'inherit' })
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  process.stdout.write(`${output}\n`)
} else if (platform === 'win') {
  const source = path.join(target, 'fund-tracker.exe')
  const output = path.join(dist, `fund-tracker-${pkg.version}-win-x64-portable.zip`)
  fs.rmSync(output, { force: true })
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${source}' -DestinationPath '${output}' -Force`])
  process.stdout.write(`${output}\n`)
} else {
  throw new Error('Expected platform: mac or win')
}
