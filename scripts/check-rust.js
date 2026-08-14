const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const candidates = [
    process.env.CARGO,
    'cargo',
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe'),
].filter(Boolean);
let last;
for (const command of candidates) {
    if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
    const result = spawnSync(command, ['check', '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit' });
    if (!result.error) process.exit(result.status || 0);
    last = result.error;
}
throw last || new Error('cargo executable not found');
