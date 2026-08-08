#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(root, 'src-tauri', 'Cargo.lock');
const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
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

if (!dryRun) {
    const cargo = fs.readFileSync(cargoPath, 'utf8').replace(
        new RegExp(`^(version\\s*=\\s*)"${oldVersion.replaceAll('.', '\\.') }"`, 'm'),
        `$1"${nextVersion}"`,
    );
    fs.writeFileSync(cargoPath, cargo);
    if (fs.existsSync(cargoLockPath)) {
        const cargoLock = fs.readFileSync(cargoLockPath, 'utf8').replace(
            new RegExp(`(name = "fund-tracker"\\nversion = )"${oldVersion.replaceAll('.', '\\.') }"`),
            `$1"${nextVersion}"`,
        );
        fs.writeFileSync(cargoLockPath, cargoLock);
    }
    const tauriConfig = readJson(tauriConfigPath);
    tauriConfig.version = nextVersion;
    writeJson(tauriConfigPath, tauriConfig);
}

console.log(`${dryRun ? 'Version bump preview' : 'Version bumped'}: ${oldVersion} -> ${nextVersion}`);
