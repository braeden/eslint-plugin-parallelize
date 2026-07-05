'use strict';

const { describe, it } = require('node:test');
const { RuleTester } = require('eslint');
const rule = require('../lib/rules/no-sequential-await.js');

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-sequential-await', rule, {
  valid: [
    // A single await has nothing to parallelize with.
    'async function t() {\n  await foo();\n}',

    // Read-after-write: bar needs a.
    'async function t() {\n  const a = await foo();\n  const b = await bar(a);\n  return b;\n}',

    // Read-after-write through a property access.
    'async function t() {\n  const a = await foo();\n  const b = await bar(a.id);\n  return b;\n}',

    // A dependency chain leaves nothing to group.
    'async function t() {\n  const a = await f();\n  const b = await g(a);\n  const c = await h(b);\n  return c;\n}',

    // Dependency through destructured binding.
    'async function t() {\n  const { id } = await f();\n  return await g(id);\n}',

    // Write-after-read: reordering would change what foo(x) sees.
    'async function t(p) {\n  let x = p;\n  const a = await foo(x);\n  x = await bar();\n  return [a, x];\n}',

    // Write-after-write: last write must win.
    'async function t() {\n  let x;\n  x = await f();\n  x = await g();\n  return x;\n}',

    // A non-await statement is an ordering barrier between runs of one.
    'async function t() {\n  await foo();\n  console.log(1);\n  await bar();\n}',

    // Statements with nested awaits are barriers (can’t lift faithfully).
    'async function t() {\n  await a();\n  const x = await f(await g());\n  return x;\n}',

    // Awaiting already-in-flight promises sequentially costs nothing.
    'async function t(p1, p2) {\n  await p1;\n  await p2;\n}',

    // The in-flight promise was already running while foo() executed.
    'async function t(p1) {\n  await foo();\n  await p1;\n}',

    // Dependency captured by a closure.
    'async function t(arr) {\n  const x = await f();\n  await g(arr.map(y => y * x));\n}',

    // Dependency via a destructuring default value.
    'async function t() {\n  const a = await f();\n  const [b = a] = await g();\n  return b;\n}',

    // Property write then property read of the same base object.
    'async function t(obj) {\n  obj.x = await f();\n  const b = await g(obj.x);\n  return b;\n}',

    // `this.x = ...` targets can’t be tracked; treated as barriers.
    'class C {\n  async m() {\n    this.a = await f();\n    this.b = await g();\n  }\n}',

    // ignoreTry leaves try/catch blocks alone (error-handling semantics).
    {
      code: 'async function t() {\n  try {\n    await foo();\n    await bar();\n  } catch (e) {\n    handle(e);\n  }\n}',
      options: [{ ignoreTry: true }],
    },
    {
      code: 'async function t() {\n  try {\n    r();\n  } catch (e) {\n    await log1(e);\n    await log2(e);\n  }\n}',
      options: [{ ignoreTry: true }],
    },

    // Boolean logic with a single await.
    'async function t(flag) {\n  return flag && await b();\n}',

    // Boolean logic with a cross-operand data dependency (via assignment).
    'async function t() {\n  let x;\n  return (x = await f()) && await g(x);\n}',

    // Boolean logic over promises that are already in flight.
    'async function t(p1, p2) {\n  return await p1 && await p2;\n}',

    // The await inside a nested function body is separate work.
    'async function t(items) {\n  return items.every(v => sync(v)) && await check();\n}',

    // Awaits in different blocks never form a run.
    'async function t(c) {\n  if (c) {\n    await f();\n  }\n  await g();\n}',

    // Loops are no-await-in-loop’s territory.
    'async function t(users) {\n  for (const u of users) {\n    await save(u);\n  }\n}',

    'async function t() {\n  const a = await f();\n  return a;\n}',

    // export-wrapped declarations are not analyzed (documented limitation).
    'export const a = await f();\nexport const b = await g();',

    // Multiple declarators in one statement are not analyzed.
    'async function t() {\n  const a = await f(), b = await g();\n  return [a, b];\n}',

    // Compound assignment both reads and writes; not a recognized form.
    'async function t() {\n  let x = 0;\n  let y;\n  x += await f();\n  y = await g();\n  return [x, y];\n}',

    // Condition await and body await are in different runs.
    'async function t() {\n  if (await a()) {\n    await b();\n  }\n}',
  ],

  invalid: [
    // The classic: two independent expression awaits.
    {
      code: 'async function t() {\n  await foo();\n  await bar();\n}',
      output: 'async function t() {\n  await Promise.all([foo(), bar()]);\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Two independent declarations.
    {
      code: 'async function t() {\n  const a = await foo();\n  const b = await bar();\n  return [a, b];\n}',
      output:
        'async function t() {\n  const [a, b] = await Promise.all([foo(), bar()]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Declaration + bare await: trailing hole is trimmed.
    {
      code: 'async function t() {\n  const a = await foo();\n  await bar();\n  return a;\n}',
      output:
        'async function t() {\n  const [a] = await Promise.all([foo(), bar()]);\n  return a;\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Bare await + declaration: leading hole in the pattern.
    {
      code: 'async function t() {\n  await bar();\n  const a = await foo();\n  return a;\n}',
      output:
        'async function t() {\n  const [, a] = await Promise.all([bar(), foo()]);\n  return a;\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Three independent declarations.
    {
      code: 'async function t() {\n  const a = await f1();\n  const b = await f2();\n  const c = await f3();\n  return [a, b, c];\n}',
      output:
        'async function t() {\n  const [a, b, c] = await Promise.all([f1(), f2(), f3()]);\n  return [a, b, c];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Interleaved holes: expr, decl, expr, decl.
    {
      code: 'async function t() {\n  await m();\n  const a = await foo();\n  await n();\n  const b = await bar();\n  return [a, b];\n}',
      output:
        'async function t() {\n  const [, a, , b] = await Promise.all([m(), foo(), n(), bar()]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Partial dependency: c needs a and b, but a and b are independent.
    {
      code: 'async function t() {\n  const a = await foo();\n  const b = await bar();\n  const c = await baz(a, b);\n  return c;\n}',
      output:
        'async function t() {\n  const [a, b] = await Promise.all([foo(), bar()]);\n  const c = await baz(a, b);\n  return c;\n}',
      errors: [{ messageId: 'partial', data: { count: '3', parallel: '2' } }],
    },

    // Partial dependency requiring reordering: b hoists above c.
    {
      code: 'async function t() {\n  const a = await foo();\n  const c = await baz(a);\n  const b = await bar();\n  return [b, c];\n}',
      output:
        'async function t() {\n  const [a, b] = await Promise.all([foo(), bar()]);\n  const c = await baz(a);\n  return [b, c];\n}',
      errors: [{ messageId: 'partial', data: { count: '3', parallel: '2' } }],
    },

    // Diamond: a, then {b, c} in parallel, then d.
    {
      code: 'async function t() {\n  const a = await f();\n  const b = await g(a);\n  const c = await h(a);\n  const d = await i(b, c);\n  return d;\n}',
      output:
        'async function t() {\n  const a = await f();\n  const [b, c] = await Promise.all([g(a), h(a)]);\n  const d = await i(b, c);\n  return d;\n}',
      errors: [{ messageId: 'partial', data: { count: '4', parallel: '2' } }],
    },

    // let declarations keep their kind.
    {
      code: 'async function t() {\n  let a = await f();\n  let b = await g();\n  return [a, b];\n}',
      output:
        'async function t() {\n  let [a, b] = await Promise.all([f(), g()]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // var declarations keep their kind.
    {
      code: 'async function t() {\n  var a = await f();\n  var b = await g();\n  return [a, b];\n}',
      output:
        'async function t() {\n  var [a, b] = await Promise.all([f(), g()]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Mixed const/let: reported, but no faithful single-statement fix.
    {
      code: 'async function t() {\n  const a = await foo();\n  let b = await bar();\n  return [a, b];\n}',
      output: null,
      errors: [{ messageId: 'independent' }],
    },

    // Assignments to existing bindings: reported, fix withheld.
    {
      code: 'async function t() {\n  let x;\n  let y;\n  x = await foo();\n  y = await bar();\n  return [x, y];\n}',
      output: null,
      errors: [{ messageId: 'independent' }],
    },

    // Property write beside an independent declaration: reported, no fix.
    {
      code: 'async function t(obj) {\n  obj.x = await f();\n  const b = await g();\n  return b;\n}',
      output: null,
      errors: [{ messageId: 'independent' }],
    },

    // Comments between statements: reported, fix withheld to preserve them.
    {
      code: 'async function t() {\n  await foo();\n  // then\n  await bar();\n}',
      output: null,
      errors: [{ messageId: 'independent' }],
    },

    // Shared reads are not conflicts.
    {
      code: 'async function t(cfg) {\n  const a = await f(cfg);\n  const b = await g(cfg);\n  return [a, b];\n}',
      output:
        'async function t(cfg) {\n  const [a, b] = await Promise.all([f(cfg), g(cfg)]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Method calls on the same receiver are reads, not conflicts.
    {
      code: "async function t(api) {\n  await api.get('/a');\n  await api.get('/b');\n}",
      output:
        "async function t(api) {\n  await Promise.all([api.get('/a'), api.get('/b')]);\n}",
      errors: [{ messageId: 'independent' }],
    },

    // A callback parameter shadowing an outer binding is not a dependency.
    {
      code: 'async function t(arr) {\n  const x = await f();\n  await g(arr.map(x => x * 2));\n  return x;\n}',
      output:
        'async function t(arr) {\n  const [x] = await Promise.all([f(), g(arr.map(x => x * 2))]);\n  return x;\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Awaiting an in-flight promise, then starting new work: the new work
    // should not have waited.
    {
      code: 'async function t(p1) {\n  await p1;\n  await foo();\n}',
      output: 'async function t(p1) {\n  await Promise.all([p1, foo()]);\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Destructuring patterns carry into the combined pattern.
    {
      code: 'async function t() {\n  const { a } = await f();\n  const [b] = await g();\n  return [a, b];\n}',
      output:
        'async function t() {\n  const [{ a }, [b]] = await Promise.all([f(), g()]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Sequence expressions get re-parenthesized inside the array.
    {
      code: 'async function t(x, y) {\n  const a = await (x(), y());\n  const b = await bar();\n  return [a, b];\n}',
      output:
        'async function t(x, y) {\n  const [a, b] = await Promise.all([(x(), y()), bar()]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // new expressions count as starting work.
    {
      code: 'async function t() {\n  await new A().init();\n  await new B().init();\n}',
      output:
        'async function t() {\n  await Promise.all([new A().init(), new B().init()]);\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Tagged templates count as calls.
    {
      code: 'async function t(sql) {\n  const a = await sql`SELECT 1`;\n  const b = await sql`SELECT 2`;\n  return [a, b];\n}',
      output:
        'async function t(sql) {\n  const [a, b] = await Promise.all([sql`SELECT 1`, sql`SELECT 2`]);\n  return [a, b];\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Dynamic imports count as calls.
    {
      code: "async function t() {\n  const m1 = await import('./m1.js');\n  const m2 = await import('./m2.js');\n  return [m1, m2];\n}",
      output:
        "async function t() {\n  const [m1, m2] = await Promise.all([import('./m1.js'), import('./m2.js')]);\n  return [m1, m2];\n}",
      errors: [{ messageId: 'independent' }],
    },

    // Top-level await in modules.
    {
      code: 'const a = await foo();\nconst b = await bar();\nconsole.log(a, b);',
      output:
        'const [a, b] = await Promise.all([foo(), bar()]);\nconsole.log(a, b);',
      errors: [{ messageId: 'independent' }],
    },

    // Two separate runs around a barrier: both reported and fixed.
    {
      code: "async function t() {\n  await f1();\n  await f2();\n  console.log('mid');\n  await f3();\n  await f4();\n}",
      output:
        "async function t() {\n  await Promise.all([f1(), f2()]);\n  console.log('mid');\n  await Promise.all([f3(), f4()]);\n}",
      errors: [{ messageId: 'independent' }, { messageId: 'independent' }],
    },

    // Inside a nested block, indentation is preserved.
    {
      code: 'async function t(c) {\n  if (c) {\n    await foo();\n    await bar();\n  }\n}',
      output:
        'async function t(c) {\n  if (c) {\n    await Promise.all([foo(), bar()]);\n  }\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Inside a switch case.
    {
      code: 'async function t(k) {\n  switch (k) {\n    case 1:\n      await foo();\n      await bar();\n  }\n}',
      output:
        'async function t(k) {\n  switch (k) {\n    case 1:\n      await Promise.all([foo(), bar()]);\n  }\n}',
      errors: [{ messageId: 'independent' }],
    },

    // try blocks are checked by default.
    {
      code: 'async function t() {\n  try {\n    await foo();\n    await bar();\n  } catch (e) {\n    handle(e);\n  }\n}',
      output:
        'async function t() {\n  try {\n    await Promise.all([foo(), bar()]);\n  } catch (e) {\n    handle(e);\n  }\n}',
      errors: [{ messageId: 'independent' }],
    },

    // ignoreTry does not silence blocks outside try/catch.
    {
      code: 'async function t() {\n  await foo();\n  await bar();\n}',
      options: [{ ignoreTry: true }],
      output: 'async function t() {\n  await Promise.all([foo(), bar()]);\n}',
      errors: [{ messageId: 'independent' }],
    },

    // Boolean logic: && short-circuits into sequential awaits.
    {
      code: 'async function t() {\n  const ok = await a() && await b();\n  return ok;\n}',
      output: null,
      errors: [{ messageId: 'booleanLogic', data: { count: '2' } }],
    },

    // Boolean logic in a condition.
    {
      code: 'async function t() {\n  if (await a() || await b()) {\n    d();\n  }\n}',
      output: null,
      errors: [{ messageId: 'booleanLogic', data: { count: '2' } }],
    },

    // Nested logical tree reports once, at the top.
    {
      code: 'async function t() {\n  return await a() && (await b() || await c());\n}',
      output: null,
      errors: [{ messageId: 'booleanLogic', data: { count: '3' } }],
    },

    // Logic mixed with comparisons.
    {
      code: 'async function t() {\n  return (await a()) === 1 && await b();\n}',
      output: null,
      errors: [{ messageId: 'booleanLogic', data: { count: '2' } }],
    },

    // In-flight promise || new work: the call still waits on short-circuit.
    {
      code: 'async function t(p1) {\n  return await p1 || await c();\n}',
      output: null,
      errors: [{ messageId: 'booleanLogic', data: { count: '2' } }],
    },
  ],
});
