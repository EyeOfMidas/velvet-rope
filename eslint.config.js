import js from '@eslint/js';
import globals from 'globals';

export default [
  // Flat config doesn't read .gitignore, so the gitignored local folders are listed here too.
  { ignores: ['**/node_modules/', 'example/data/', 'coverage/', '.claude/', 'plan/'] },
  js.configs.recommended,
  {
    files: [
      'src/domain/**/*.js',
      'src/server/**/*.js',
      'src/testing/**/*.js',
      'test/**/*.js',
      'example/*.js',
      '*.config.js',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/client/**/*.js', 'src/ui/**/*.js', 'test/client/**/*.js', 'example/web/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
];
