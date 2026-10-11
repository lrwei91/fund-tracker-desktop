const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');
const config = require('../src-tauri/tauri.conf.json');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist/updater');
const repository = 'lrwei91/fund-tracker-desktop';
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function validate(part, directory, version) {
    if (part.version !== version || !['darwin-aarch64', 'windows-x86_64'].includes(part.platform)) throw new Error('更新平台或版本不匹配');
    const expectedFile = `fund-tracker-${version}-${part.platform === 'darwin-aarch64' ? 'mac-arm64.app.tar.gz' : 'win-x64-setup.exe'}`;
    if (part.file !== expectedFile) throw new Error('更新包文件名不允许');
    const bytes = fs.readFileSync(path.join(directory, part.file));
    const signature = fs.readFileSync(path.join(directory, part.file + '.sig'), 'utf8').trim();
    if (bytes.length === 0 || bytes.length > 128 * 1024 * 1024 || digest(bytes) !== part.sha256 || signature !== part.signature) throw new Error('更新文件校验失败');
    if (!signature || !Buffer.from(signature, 'base64').toString('utf8').includes('trusted comment:')) throw new Error('缺少更新签名');
    if (part.pubkeyHash !== digest(config.plugins.updater.pubkey)) throw new Error('签名公钥配置不匹配');
    return part;
}
function collect(platform) {
    const mac = platform === 'mac';
    if (!mac && platform !== 'win') throw new Error('平台必须为 mac 或 win');
    const directory = path.join(root, 'src-tauri/target/release/bundle', mac ? 'macos' : 'nsis');
    const files = fs.readdirSync(directory).filter(name => mac ? name === '恭喜发财.app.tar.gz' : name.endsWith('_x64-setup.exe'));
    if (files.length !== 1) throw new Error('没有唯一的更新包；请使用签名更新构建命令');
    const source = path.join(directory, files[0]);
    if (mac) {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-update-signature-'));
        try {
            execFileSync('/usr/bin/tar', ['-xzf', source, '-C', temporary]);
            execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(temporary, '恭喜发财.app')], { stdio: 'pipe' });
        } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
    const file = `fund-tracker-${pkg.version}-${mac ? 'mac-arm64.app.tar.gz' : 'win-x64-setup.exe'}`;
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(source, path.join(output, file));
    fs.copyFileSync(source + '.sig', path.join(output, file + '.sig'));
    const part = { version: pkg.version, platform: mac ? 'darwin-aarch64' : 'windows-x86_64', file, sha256: digest(fs.readFileSync(source)), signature: fs.readFileSync(source + '.sig', 'utf8').trim(), pubkeyHash: digest(config.plugins.updater.pubkey) };
    validate(part, output, pkg.version);
    fs.writeFileSync(path.join(output, part.platform + '.part.json'), JSON.stringify(part, null, 2) + '\n');
    console.log(`已收集 ${part.platform} 更新包和签名`);
}
function manifest(directory = output, version = pkg.version, notes = '') {
    const parts = ['darwin-aarch64', 'windows-x86_64'].map(platform => {
        const part = validate(JSON.parse(fs.readFileSync(path.join(directory, platform + '.part.json'), 'utf8')), directory, version);
        if (part.platform !== platform) throw new Error('更新清单平台重复或错配');
        return part;
    });
    const platforms = {};
    for (const part of parts) platforms[part.platform] = { signature: part.signature, url: `https://github.com/${repository}/releases/download/v${version}/${part.file}` };
    return { version, pub_date: new Date().toISOString(), notes, platforms };
}
if (require.main === module) {
    const command = process.argv[2];
    if (command === 'manifest') {
        const notes = process.env.UPDATE_NOTES_FILE ? fs.readFileSync(process.env.UPDATE_NOTES_FILE, 'utf8') : '';
        fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(manifest(output, pkg.version, notes), null, 2) + '\n');
        console.log('已验证双平台文件，生成 latest.json');
    } else collect(command);
}
module.exports = { manifest, validate, digest };
