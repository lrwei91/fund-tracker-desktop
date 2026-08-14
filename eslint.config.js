// ESLint flat config — fund-tracker
// 区分 Node 工程脚本与浏览器 renderer。
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
    {
        ignores: ['dist/**', '.tauri-frontend/**', 'src-tauri/target/**', 'node_modules/**', 'app/vendor/**', 'build/**', 'test/**', 'coverage/**'],
    },
    js.configs.recommended,
    {
        files: ['scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        // 浏览器渲染上下文(window.AppX / document / fetch)
        files: ['app/app.js', 'app/theme.js', 'app/tauri-shell.js', 'app/modules/**/*.js', 'renderer/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser, ...globals.node },
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['app/config-schema.js'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        files: ['services/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-undef': 'error',
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
