import noSequentialAwait from './rules/no-sequential-await';

// Resolves to the package root both in-repo and in the published tarball.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

const plugin = {
  meta: {
    name: 'eslint-plugin-parallelize',
    version,
  },
  rules: {
    'no-sequential-await': noSequentialAwait,
  },
  configs: {} as Record<string, unknown>,
};

plugin.configs.recommended = {
  plugins: { parallelize: plugin },
  rules: {
    'parallelize/no-sequential-await': 'warn',
  },
};

export = plugin;
