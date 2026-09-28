/**
 * Flat ESLint config.
 *
 * Deliberately small: rules that catch real mistakes in an ESM + JSDoc codebase with no
 * type checker, and nothing that argues about whitespace. There is no formatter wired
 * up yet, and a lint run that reformats the tree would bury real findings in noise.
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['node_modules/**', 'naten/**'] },

  js.configs.recommended,

  {
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // `after-used` catches a trailing parameter nothing reads — how
      // formatResults(outcome, ops) kept a second argument that was pure decoration, and
      // an invitation for a caller to assume it mattered. Parameters before a used one
      // are still allowed: they document a callback's shape. `_`-prefixed names are an
      // explicit "yes, I know".
      'no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.jsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Only the two classic hook rules. The plugin's newer React Compiler rules
      // (immutability, set-state-in-effect) are off on purpose: the panes mutate the
      // session object they are handed, which is the architecture DAVAI.md describes —
      // the UI is a view over state the harness owns. Those rules would flag the
      // design, not a bug.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // esbuild rewrites JSX to React.createElement, which ESLint cannot see without
      // the React plugin — so the import looks unused. Cheaper than adding the plugin.
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^(_|React$)',
          caughtErrors: 'none',
        },
      ],
    },
  },
];
