import apify from '@apify/eslint-config';

// eslint-disable-next-line import/no-default-export
export default [
    { ignores: ['**/dist'] }, // Ignores need to happen first
    ...apify,
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
];
