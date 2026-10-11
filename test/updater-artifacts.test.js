import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { manifest, digest } = require('../scripts/updater-artifacts.js');
const config = require('../src-tauri/tauri.conf.json');

describe('签名更新清单', () => {
    it('双平台必须齐全，文件被篡改或平台错配时拒绝发布清单', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-update-test-'));
        try {
            const signature = Buffer.from('untrusted comment: test\nRWfake\ntrusted comment: test\n').toString('base64');
            const add = (platform, suffix) => {
                const file = `fund-tracker-1.0.6-${suffix}`;
                const body = Buffer.from(platform);
                fs.writeFileSync(path.join(directory, file), body);
                fs.writeFileSync(path.join(directory, file + '.sig'), signature);
                fs.writeFileSync(path.join(directory, platform + '.part.json'), JSON.stringify({ version: '1.0.6', platform, file, signature, sha256: digest(body), pubkeyHash: digest(config.plugins.updater.pubkey) }));
            };
            add('darwin-aarch64', 'mac-arm64.app.tar.gz');
            expect(() => manifest(directory, '1.0.6')).toThrow();
            add('windows-x86_64', 'win-x64-setup.exe');
            const result = manifest(directory, '1.0.6', '新版说明');
            expect(Object.keys(result.platforms)).toEqual(['darwin-aarch64', 'windows-x86_64']);
            expect(result.platforms['windows-x86_64'].url).toContain('/v1.0.6/fund-tracker-1.0.6-win-x64-setup.exe');
            expect(() => manifest(directory, '1.0.7')).toThrow('版本不匹配');
            fs.appendFileSync(path.join(directory, 'fund-tracker-1.0.6-win-x64-setup.exe'), 'tampered');
            expect(() => manifest(directory, '1.0.6')).toThrow('校验失败');
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
});
