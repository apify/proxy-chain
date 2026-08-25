import { defineConfig } from 'vitest/config';

// Mocha's default ceiling, kept so a hang or a slow-path regression still fails fast.
// The handful of genuinely slow cases carry their own timeout at the test or hook.
const E2E_TIMEOUT_MILLIS = 2_000;

// eslint-disable-next-line import/no-default-export
export default defineConfig({
    test: {
        coverage: {
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**'],
        },
        projects: [
            {
                test: {
                    name: 'unit',
                    include: ['test/unit/**/*.js'],
                },
            },
            {
                test: {
                    name: 'e2e',
                    include: ['test/e2e/**/*.js'],
                    testTimeout: E2E_TIMEOUT_MILLIS,
                    hookTimeout: E2E_TIMEOUT_MILLIS,
                    // Several tests send deliberately malformed headers. Bun ignores
                    // execArgv, so `test:bun:e2e:full` passes the same flag through
                    // NODE_OPTIONS — keep the two in sync.
                    execArgv: ['--insecure-http-parser'],
                    // Half the e2e files pick ports by scanning a shared range through
                    // portastic, which only proves a port is free at scan time. Until
                    // those files bind port 0 instead, serializing is what keeps them
                    // from handing out the same port.
                    // TODO: switch them to `port: 0` and drop this.
                    fileParallelism: false,
                },
            },
        ],
    },
});
