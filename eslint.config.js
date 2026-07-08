// ESLint flat config — fund-tracker
// 区分 Node 上下文(main/preload/api) 与 浏览器上下文(modules/renderer)
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
    {
        ignores: ['dist/**', 'node_modules/**', 'build/**', 'test/**', 'coverage/**'],
    },
    js.configs.recommended,
    {
        // Node / CommonJS 上下文
        files: ['main.js', 'preload.js', 'scripts/**/*.js', 'app/api/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-undef': 'error',
            // 空 catch 块降级为警告:团队既有"吞掉非致命持久化错误"约定,留作待清理
            'no-empty': 'warn',
        },
    },
    {
        // 浏览器渲染上下文(window.AppX / document / fetch)
        files: ['app/app.js', 'app/modules/**/*.js', 'renderer/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser, ...globals.node },
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-undef': 'error',
            'no-empty': 'warn',
        },
    },
    {
        // 工程配置自身(Node / CommonJS)
        files: ['eslint.config.js', 'vitest.config.js', '*.config.js', '*.config.cjs', '.eslintrc.cjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
    {
        // Vitest 单测(可能引用 window/document 等浏览器全局 + vitest 全局)
        files: ['test/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
                vi: 'readonly',
            },
        },
    },
    prettier,
];
