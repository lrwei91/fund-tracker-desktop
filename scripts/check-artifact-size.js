const fs = require('fs');
const path = require('path');

const limit = 20 * 1024 * 1024;
const baseline = { mac: 115 * 1024 * 1024, win: 85 * 1024 * 1024 };
const files = fs.existsSync(path.resolve(__dirname, '../dist'))
    ? fs.readdirSync(path.resolve(__dirname, '../dist')).filter((name) => name.endsWith('.zip'))
    : [];

if (files.length === 0) throw new Error('dist 中没有可检查的 ZIP 产物');
for (const name of files) {
    const bytes = fs.statSync(path.resolve(__dirname, '../dist', name)).size;
    const platform = name.includes('-mac-') ? 'mac' : name.includes('-win-') ? 'win' : null;
    if (!platform) throw new Error(`无法识别产物平台: ${name}`);
    const reduction = ((1 - bytes / baseline[platform]) * 100).toFixed(1);
    console.log(`${name}: ${(bytes / 1024 / 1024).toFixed(2)} MB，较基线下降 ${reduction}%`);
    if (bytes > limit) throw new Error(`${name} 超过 20 MB 门禁`);
}
