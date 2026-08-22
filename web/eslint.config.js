// Lint config for the desktop app.
//
// Deliberately narrow. This codebase has a consistent house style already and a
// linter that argues about formatting would produce hundreds of findings nobody
// reads, which is how linting gets switched off. What is enabled here is the
// set of rules that catch things a careful reviewer would also flag as bugs:
// variables that do not exist, promises nobody awaits, cases that fall through.
//
// Two environments with genuinely different globals — main process code is
// CommonJS on Node, the renderer is ES modules in a browser — so they get
// separate blocks rather than one permissive union that would let a `window`
// reference into the main process unnoticed.

const js = require('@eslint/js')
const globals = require('globals')
const react = require('eslint-plugin-react')
const reactHooks = require('eslint-plugin-react-hooks')

module.exports = [
  {
    ignores: ['dist/**', 'dist-electron/**', 'browsers/**', 'node_modules/**'],
  },

  // ─── Main process, services, tests: CommonJS on Node ───────────
  {
    files: ['electron/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // An unused argument is often deliberate (a callback signature that has
      // to match); an unused *variable* usually means a rename went half-done.
      // ignoreRestSiblings covers `const { secret, ...rest } = row`, which is
      // how several places here strip fields — the "unused" binding IS the
      // point of the statement.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // `catch {}` appears throughout on purpose — accounting and logging must
      // never break the thing they measure — and each one is commented.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The bugs worth catching automatically.
      'no-await-in-loop': 'off', // sequential applies are the point, not a mistake
      'no-fallthrough': 'error',
      'no-constant-binary-expression': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unsafe-optional-chaining': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // Off, with reasons — each of these fires on a correct idiom used
      // throughout, and a rule that is wrong more often than it is right
      // teaches people to ignore the whole run.
      //
      // `new Promise(r => setTimeout(r, ms))` returns the timer id from the
      // executor. Harmless, and the alternative is a block body everywhere.
      'no-promise-executor-return': 'off',
      // Fires on every `x = await f()` after a prior read of x. Real races
      // exist, but every instance here is sequential code in a single-threaded
      // process, and the rule cannot tell the difference.
      'require-atomic-updates': 'off',
      // The control characters in the sanitising regexes are the point: they
      // are what is being stripped.
      'no-control-regex': 'off',
      // Redundant backslashes in regex character classes. Genuinely harmless,
      // and worth tidying — but not worth failing a release over, and these
      // live in scraper regexes with no test coverage to catch a slip.
      'no-useless-escape': 'warn',
    },
  },

  // ─── Code that runs inside the scraped page ────────────────────
  // page.evaluate() callbacks are serialised and executed in Chromium, so
  // `document` and `window` are real there. They are Node files everywhere
  // else, hence both global sets rather than a swap.
  {
    files: ['electron/services/scraper/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ─── Code that runs inside the app's own renderer ──────────────
  // The smoke test drives the packaged app through page.evaluate(), so its
  // callbacks execute in Chromium with `window.api` attached. Same reasoning as
  // the scraper block above: Node file, browser callbacks.
  {
    files: ['test/smoke/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ─── Renderer tests: ES modules, browser + the test runner's globals ──
  // These run under vitest in jsdom, so they are ES modules like the renderer
  // itself, but they also reach Node APIs — the preload-contract test patches
  // Node's module loader to feed the real CommonJS preload a fake `electron`.
  {
    files: ['test/renderer/**/*.js', 'test/renderer/**/*.jsx', 'vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { react },
    rules: {
      ...js.configs.recommended.rules,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // ─── Renderer: ES modules in a browser ─────────────────────────
  {
    files: ['src/**/*.js', 'src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    // Only the two React rules that teach no-unused-vars to see JSX. Without
    // them every component defined and then rendered reads as dead code, which
    // is 80 false positives and a linter nobody trusts. The rest of the React
    // plugin is opinion this codebase has not asked for.
    //
    // react-hooks is the exception, and it earns its place on the same standard
    // as everything else here: both rules catch things a careful reviewer would
    // also flag as bugs, and neither is a style opinion.
    //   rules-of-hooks — a hook called conditionally corrupts React's internal
    //     hook order. It is always a bug and never a preference.
    //   exhaustive-deps — a dependency array missing a value the effect reads
    //     is a stale closure: the effect keeps using the first render's value
    //     forever. This is exactly the class of bug that produces "the UI is
    //     showing an old number and nobody can reproduce it".
    // exhaustive-deps is a warning rather than an error: a handful of the
    // effects here intentionally run on a narrower trigger than what they read,
    // and those are judgement calls that deserve a comment, not a build break.
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-binary-expression': 'error',
      'no-unsafe-optional-chaining': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
]
