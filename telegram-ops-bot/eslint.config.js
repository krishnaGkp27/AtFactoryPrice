'use strict';

/**
 * ESLint flat config — correctness-focused.
 *
 * Philosophy: ESLint catches BUGS here; Prettier owns formatting (so
 * eslint-config-prettier switches off any stylistic rules that would fight
 * the formatter). We start from @eslint/js "recommended" and tune a few
 * rules to match this codebase's deliberate idioms (e.g. `catch (_) {}`).
 *
 * Introduced incrementally (TG-26): the high-signal, bug-indicating rules are
 * errors; noisier hygiene rules (unused vars, console) are warnings so the
 * existing ~50-file codebase isn't blocked by a backlog on day one.
 */

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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

  // Turn off rules that would conflict with Prettier's formatting.
  prettier,
];
