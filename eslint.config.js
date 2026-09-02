// Lint config for the two halves of the repo that had none: the mobile
// companion app (app/) and the browser extension (extension/).
//
// The desktop app carries its own config in web/eslint.config.js and is ignored
// here — it has React and Electron-specific plugins that neither of these needs,
// and one union config would mean loading all of it to lint four files in
// extension/.
//
// Why this exists at all: `npx expo export` proves the mobile bundle builds,
// which catches a syntax error and a bad import and nothing else. It says
// nothing about a variable that does not exist, a promise nobody awaits, or a
// `catch` that swallows a rename — which is roughly 2,300 lines of screens and
// crypto going unchecked, including the pairing protocol that has to agree
// bit-for-bit with the desktop.
//
// Same narrow philosophy as web/eslint.config.js: rules that catch what a
// careful reviewer would flag as a bug, nothing that argues about formatting.

const js = require('@eslint/js')
const globals = require('globals')
const react = require('eslint-plugin-react')

// The rules both halves share. Kept in one place so the two environments below
// differ only in their globals and module system, which is the only way they
// actually differ.
const shared = {
  ...js.configs.recommended.rules,
  // An unused argument is often deliberate (a callback signature that has to
  // match); an unused *variable* usually means a rename went half-done.
  'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  // `catch {}` is used deliberately in both codebases — a failed keychain read
  // must not strand the user signed out — and each one is commented.
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'no-constant-binary-expression': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unsafe-optional-chaining': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-promise-executor-return': 'off',
  'require-atomic-updates': 'off',
  'no-useless-escape': 'warn',
}

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      'web/**',          // has its own config — see web/eslint.config.js
      'dist/**',
      'dist-electron/**',
      'app/dist/**',
      'app/.expo/**',
    ],
  },

  // ─── Mobile companion: ES modules, React Native ────────────────
  {
    files: ['app/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // The screens are JSX. Metro strips it; espree needs telling.
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,   // fetch, URL, TextDecoder, btoa/atob, console
        ...globals.es2021,
        __DEV__: 'readonly',
        // Metro substitutes process.env at build time, so `process` is real in
        // app code even though there is no Node runtime under it.
        process: 'readonly',
      },
    },
    plugins: { react },
    rules: {
      ...shared,
      // Without these, every component referenced only inside JSX — which is
      // every component — reads as an unused import. They mark JSX identifiers
      // as used; they report nothing themselves.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },

  // ─── Mobile: the files that are deliberately plain CommonJS ────
  // src/httpJson.js, src/stats.js and src/dates.js avoid every react-native and
  // expo import so the plain-Node test suite can require them. The scripts and
  // the tests are Node too.
  {
    files: [
      'app/src/httpJson.js',
      'app/src/stats.js',
      'app/src/dates.js',
      'app/test/**/*.js',
      'app/scripts/**/*.js',
      'app/babel.config.js',
      'app/app.config.js',
      'eslint.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: shared,
  },

  // ─── Browser extension: MV3 popup and the two protocol modules ─
  // Classic scripts loaded by popup.html, so they share one global scope and
  // reference each other through globals rather than imports — hence the
  // cross-file names declared here rather than a no-undef exemption.
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        module: 'writable',        // pairChannel.js is also required by web/test
        HiroProtocol: 'readonly',
        HiroPairChannel: 'readonly',
      },
    },
    rules: shared,
  },
]
