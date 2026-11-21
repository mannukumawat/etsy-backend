// ESLint flat config (L1). Minimal: the recommended rule sets, no extra plugins.
// Type-aware rules are deliberately off — the generated Prisma client is not
// available in every checkout, and typed linting would fail the whole run for
// that environment reason alone. Run with `npm run lint`.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'prisma/**/*.ts', 'scripts/**/*.ts', 'api/**/*.ts'],
    rules: {
      // The codebase pre-dates linting and leans on `any` in raw-SQL helpers;
      // warn instead of erroring so `npm run lint` stays usable while the
      // old code is cleaned up file by file.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
