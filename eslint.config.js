'use strict';

const parallelize = require('./lib/index.js');

module.exports = [
  {
    files: ['examples/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    plugins: { parallelize },
    rules: {
      'parallelize/no-sequential-await': 'warn',
    },
  },
];
