import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
    { ignores: ['dist/', 'coverage/', 'node_modules/'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: { globals: { ...globals.node } },
    },
    {
        files: ['examples/simulator/public/**/*.js'],
        languageOptions: { globals: { ...globals.browser } },
    },
    {
        files: ['test/**/*.ts'],
        rules: { '@typescript-eslint/no-non-null-assertion': 'off', '@typescript-eslint/no-explicit-any': 'off' },
    },
    prettier,
);
