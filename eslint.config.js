import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/', 'example/data/'] },
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
