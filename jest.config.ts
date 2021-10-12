import type { Config } from '@jest/types';

<<<<<<< HEAD
// eslint-disable-next-line import/no-default-export
=======
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
export default (): Config.InitialOptions => ({
    verbose: true,
    preset: 'ts-jest',
    testEnvironment: 'node',
    testRunner: 'jest-circus/runner',
    testTimeout: 20_000,
    collectCoverage: true,
    collectCoverageFrom: [
        '**/src/**/*.ts',
        '**/src/**/*.js',
        '!**/node_modules/**',
    ],
    maxWorkers: 3,
    globals: {
        'ts-jest': {
            tsconfig: '<rootDir>/test/tsconfig.json',
        },
    },
});
