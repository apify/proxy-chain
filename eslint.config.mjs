import apifyTypescriptConfig from '@apify/eslint-config/ts.js';

// eslint-disable-next-line import/no-default-export
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
            'import/extensions': 'off',
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
