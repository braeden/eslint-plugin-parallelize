'use strict';

const noSequentialAwait = require('./rules/no-sequential-await.js');

const plugin = {
  meta: {
    name: 'eslint-plugin-parallelize',
    version: '0.1.0',
  },
  rules: {
    'no-sequential-await': noSequentialAwait,
  },
  configs: {},
};

plugin.configs.recommended = {
  plugins: { parallelize: plugin },
  rules: {
    'parallelize/no-sequential-await': 'warn',
  },
};

module.exports = plugin;
