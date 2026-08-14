const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const roots = ['renderer', 'app/app.js', 'app/modules'];
function collect(target) {
    const stat = fs.statSync(target);
    if (stat.isFile()) return target.endsWith('.js') ? [target] : [];
    return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) =>
        collect(path.join(target, entry.name))
    );
}
for (const file of roots.flatMap(collect)) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}
