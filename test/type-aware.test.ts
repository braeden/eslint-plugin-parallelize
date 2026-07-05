import { after, describe, it } from 'node:test';
import * as path from 'node:path';
import { RuleTester } from '@typescript-eslint/rule-tester';
import rule from '../src/rules/no-sequential-await';

// typescript-eslint RuleTester with the project service: every test case is
// type-checked, so the type-aware upgrades are active.
RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ['*.ts'],
      },
      tsconfigRootDir: path.join(__dirname, 'fixtures'),
    },
  },
});

const DECLS = [
  'declare function fetchA(): Promise<number>;',
  'declare function fetchB(): Promise<number>;',
  'declare function fetchC(): Promise<number>;',
  'declare function compute(n: number): Promise<number>;',
  'declare function parseNum(s: string): number;',
  'declare function isOn(): boolean;',
  '',
].join('\n');

ruleTester.run('no-sequential-await (type-aware)', rule, {
  valid: [
    // Awaiting sync-typed calls starts no async work — nothing to group.
    // (The syntactic rule would flag this; types remove the false positive.)
    `${DECLS}async function t() {\n  await parseNum('1');\n  await parseNum('2');\n}`,

    // Boolean logic over sync-typed calls: short-circuiting costs nothing.
    `${DECLS}async function t() {\n  if (await isOn() && await isOn()) {\n    fetchA();\n  }\n}`,

    // Real dependency, fully typed.
    `${DECLS}async function t() {\n  const a = await fetchA();\n  const b = await compute(a);\n  return b;\n}`,

    // A promise-start whose await depends on it stays ordered.
    `${DECLS}async function t() {\n  const p = fetchA();\n  const a = await p;\n  return compute(a);\n}`,

    // Sync-typed calls in a loop are not async work.
    `${DECLS}async function t(xs: string[]) {\n  for (const x of xs) {\n    await parseNum(x);\n  }\n}`,
  ],

  invalid: [
    // any-typed calls keep the syntactic behavior (no silent under-reporting).
    {
      code: 'async function t(foo: any, bar: any) {\n  await foo();\n  await bar();\n}',
      output: 'async function t(foo: any, bar: any) {\n  await Promise.all([foo(), bar()]);\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Typed independent awaits still flagged, with fix.
    {
      code: `${DECLS}async function t() {\n  const a = await fetchA();\n  const b = await fetchB();\n  return [a, b];\n}`,
      output: `${DECLS}async function t() {\n  const [a, b] = await Promise.all([fetchA(), fetchB()]);\n  return [a, b];\n}`,
      errors: [{ messageId: 'independent' }],
    },

    // Type annotations on bindings are dropped in the combined pattern.
    {
      code: `${DECLS}async function t() {\n  const a: number = await fetchA();\n  const b: number = await fetchB();\n  return [a, b];\n}`,
      output: `${DECLS}async function t() {\n  const [a, b] = await Promise.all([fetchA(), fetchB()]);\n  return [a, b];\n}`,
      errors: [{ messageId: 'independent' }],
    },

    // THE type-aware unlock: an un-awaited promise-typed declaration no
    // longer breaks the run — awaits group across it, and the promise-start
    // is emitted first (it starts work immediately either way).
    {
      code: `${DECLS}async function t() {\n  const a = await fetchA();\n  const p = fetchB();\n  const b = await fetchC();\n  return [a, b, await p];\n}`,
      output: `${DECLS}async function t() {\n  const p = fetchB();\n  const [a, b] = await Promise.all([fetchA(), fetchC()]);\n  return [a, b, await p];\n}`,
      errors: [{ messageId: 'independent', data: { count: '2', parallel: '2' } }],
    },

    // Promise-start with a dependency lands in its own later level.
    {
      code: `${DECLS}async function t() {\n  const a = await fetchA();\n  const p = compute(a);\n  const b = await fetchC();\n  return [b, await p];\n}`,
      output: `${DECLS}async function t() {\n  const [a, b] = await Promise.all([fetchA(), fetchC()]);\n  const p = compute(a);\n  return [b, await p];\n}`,
      errors: [{ messageId: 'independent', data: { count: '2', parallel: '2' } }],
    },

    // Typed loop still flagged when iterations are independent.
    {
      code: `${DECLS}async function t(ns: number[]) {\n  for (const n of ns) {\n    await compute(n);\n  }\n}`,
      output: null,
      errors: [{ messageId: 'loopSequential' }],
    },
  ],
});
