import neostandard from 'neostandard';

export default [
  ...neostandard({ semi: true, ts: true }),
  {
    ignores: ['build/test/*', 'node_modules/*', 'dist/**']
  },
  {
    files: ['tests/**/*.ts', 'plugins/*/tests/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    }
  }
];
