const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '../dist');
const limit = 20 * 1024 * 1024;
const healthy = 16 * 1024 * 1024;
const largeEntry = 10 * 1024 * 1024;
const baseline = { mac: 115 * 1024 * 1024, win: 85 * 1024 * 1024 };
const forbidden = /(^|\/)(chromium|node(?:\.exe)?|python(?:3(?:\.\d+)?)?(?:\.exe)?|tdx(?:rs)?)(\/|$)/i;

function zipEntries(buffer) {
    const signature = 0x06054b50;
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === signature) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP central directory not found');
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').split(String.fromCharCode(92)).join('/');
        entries.push({ name, size });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

if (!fs.existsSync(dist)) throw new Error('dist 中没有可检查的 ZIP 产物');
const files = fs.readdirSync(dist).filter((name) => name.endsWith('.zip'));
if (files.length === 0) throw new Error('dist 中没有可检查的 ZIP 产物');
const verifyOnly = process.argv.includes('--verify');
for (const name of files) {
    const file = path.join(dist, name);
    const body = fs.readFileSync(file);
    const bytes = body.length;
    const platform = name.includes('-mac-') ? 'mac' : name.includes('-win-') ? 'win' : null;
    if (!platform) throw new Error(`无法识别产物平台: ${name}`);
    const entries = zipEntries(body);
    const forbiddenEntries = entries.filter((entry) => forbidden.test(entry.name));
    const largeEntries = entries.filter((entry) => entry.size >= largeEntry).sort((a, b) => b.size - a.size);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const hashFile = `${file}.sha256`;
    if (verifyOnly) {
        const expected = fs.readFileSync(hashFile, 'utf8').trim().split(/\s+/)[0];
        if (expected !== sha256) throw new Error(`${name} SHA-256 校验失败`);
    } else {
        fs.writeFileSync(hashFile, `${sha256}  ${name}\n`);
    }
    const tier = bytes < healthy ? 'healthy' : bytes < limit ? 'warning' : 'blocked';
    const evidence = {
        artifact: name, platform, bytes, sizeMiB: Number((bytes / 1024 / 1024).toFixed(2)), tier,
        sha256, entryCount: entries.length, forbiddenEntries: forbiddenEntries.map((e) => e.name),
        largeEntries: largeEntries.map((e) => ({ name: e.name, bytes: e.size })),
    };
    if (!verifyOnly) fs.writeFileSync(path.join(dist, `${name}.evidence.json`), JSON.stringify(evidence, null, 2) + '\n');
    const reduction = ((1 - bytes / baseline[platform]) * 100).toFixed(1);
    console.log(`${name}: ${evidence.sizeMiB} MB [${tier}]，较基线下降 ${reduction}%，SHA-256 ${sha256}`);
    if (largeEntries.length) console.warn(`大文件: ${largeEntries.map((e) => `${e.name} (${(e.size / 1024 / 1024).toFixed(2)} MB)`).join(', ')}`);
    if (forbiddenEntries.length) throw new Error(`${name} 包含禁止运行时: ${forbiddenEntries.map((e) => e.name).join(', ')}`);
    if (bytes >= limit) throw new Error(`${name} 达到或超过 20 MB 门禁`);
}
