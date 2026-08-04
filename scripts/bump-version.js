#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const dryRun = process.argv.includes('--dry-run');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function bumpPatch(version) {
    const parts = String(version || '').split('.').map((part) => Number(part));
    if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
        throw new Error(`Unsupported semver version: ${version}`);
    }
    parts[2] += 1;
    return parts.join('.');
}

const pkg = readJson(packagePath);
const oldVersion = pkg.version;
const nextVersion = bumpPatch(oldVersion);

if (!dryRun) {
    pkg.version = nextVersion;
    writeJson(packagePath, pkg);
}

if (!dryRun && fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    lock.version = nextVersion;
    if (lock.packages && lock.packages['']) {
        lock.packages[''].version = nextVersion;
    }
    writeJson(lockPath, lock);
}

console.log(`${dryRun ? 'Version bump preview' : 'Version bumped'}: ${oldVersion} -> ${nextVersion}`);
