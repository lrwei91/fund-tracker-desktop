const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['test/**/*.test.js'],
        coverage: {
            provider: 'v8',
            include: ['app/api/**/*.js', 'app/modules/utils.js'],
        },
    },
});
