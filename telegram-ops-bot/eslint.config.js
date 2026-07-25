'use strict';

/**
 * ESLint flat config — correctness-focused.
 *
 * Philosophy: ESLint catches BUGS here; formatting is hand-maintained in the
 * house style. Prettier was configured but never run against this codebase —
 * it would have rewritten 381 files and expanded the 162 one-line
 * `try { … } catch (_) {}` idioms to five lines each — so it was removed
 * (25-Jul-2026) rather than left as a trap for `npm run format`. Verified at
 * removal that dropping eslint-config-prettier changed nothing: 135 warnings,
 * 0 errors, before and after. We start from @eslint/js "recommended" and tune
 * a few rules to match this codebase's deliberate idioms (e.g. `catch (_) {}`).
 *
 * Introduced incrementally (TG-26): the high-signal, bug-indicating rules are
 * errors; noisier hygiene rules (unused vars, console) are warnings so the
 * existing ~50-file codebase isn't blocked by a backlog on day one.
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'data/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // ── Real bug catchers (errors) ──────────────────────────────────────
      // (most are already errors in recommended; listed for intent/clarity)
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-fallthrough': 'error',

      // Empty `catch (_) {}` is a deliberate idiom in this codebase.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // ── Hygiene (warnings — surfaced, not blocking) ─────────────────────
      // These flag style/cleanup, not behavior bugs, so they don't fail the
      // build on the existing codebase — they're cleaned up lint-on-touch.
      // `caughtErrors` defaults to 'all' in ESLint 9, so the deliberate
      // `catch (_)` idiom above produced 326 of the 387 unused-var warnings
      // and buried the ~61 genuinely unused names. Ignore the same `_`
      // prefix for caught errors that args/vars already use.
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-useless-escape': 'warn', // redundant regex escapes — harmless
      'no-useless-assignment': 'warn', // dead assignment — worth a look, not a crash
      'preserve-caught-error': 'warn', // missing error `cause` — hygiene
    },
  },

  // node:test files use the built-in runner (required, not global) — nothing
  // extra needed, but keep the Node globals explicit.
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
