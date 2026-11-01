/**
 * Flat ESLint config.
 *
 * Deliberately small: rules that catch real mistakes in an ESM + JSDoc codebase with no
 * type checker, and nothing that argues about whitespace. There is no formatter wired
 * up yet, and a lint run that reformats the tree would bury real findings in noise.
 */
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
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
    // The web sidecar's client. The only browser code in the tree: it runs in a page,
    // not in node, and uPlot arrives as a global script tag rather than an import so
    // that serving it needs no build step.
    files: ['src/ui/web/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, uPlot: 'readonly' },
    },
  },

  {
    files: ['**/*.jsx'],
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      // Only the two classic hook rules. The plugin's newer React Compiler rules
      // (immutability, set-state-in-effect) are off on purpose: the panes mutate the
      // session object they are handed, which is the architecture DAVAI.md describes —
      // the UI is a view over state the harness owns. Those rules would flag the
      // design, not a bug.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Core no-unused-vars never looks inside JSX, so a component referenced only as
      // <Box/> reads as an unused import. These two rules are the entire reason
      // eslint-plugin-react is a dependency; nothing else from it is enabled. The old
      // `varsIgnorePattern: '^(_|React$)'` was a guess at the same problem that only
      // covered the one identifier anybody had noticed — it hid 42 real reports behind
      // an exemption for React alone. jsx-uses-react marks the import used under the
      // classic runtime esbuild compiles to, so the base block's rule now applies to
      // .jsx unchanged.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
];
