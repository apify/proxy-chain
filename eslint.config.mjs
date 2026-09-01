import apifyTypescriptConfig from '@apify/eslint-config/ts.js';

// eslint-disable-next-line import-x/no-default-export
export default [
    { ignores: ['**/dist'] }, // Ignores need to happen first
    ...apifyTypescriptConfig,
    {
        languageOptions: {
            sourceType: 'module',

            parserOptions: {
                project: 'tsconfig.eslint.json',
            },
        },
        rules: {
            'no-param-reassign': 'off',
            'import-x/extensions': 'off',
        },
    },
    {
        files: ['vitest.config.ts'],
        rules: {
            'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }],
        },
    },
    {
        files: ['test/**'],
        rules: {
            'no-console': 'off',
            'no-promise-executor-return': 'off',
            'consistent-return': 'off',
            '@typescript-eslint/no-empty-function': 'off',
        },
    },
];
