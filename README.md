# eslint-plugin-parallelize

An ESLint rule that finds `await`s that run **sequentially but don't depend on each other**, and auto-fixes them into maximally parallel `Promise.all` groupings.

```js
// before
const user = await fetchUser();
const posts = await fetchPosts();
const enriched = await enrich(user, posts);

// after --fix
const [user, posts] = await Promise.all([fetchUser(), fetchPosts()]);
const enriched = await enrich(user, posts);
```

The rule assumes your async operations are **side-effect free with respect to each other** — i.e. it is semantically safe to start them in any order. That assumption is what makes the rewrite sound; if your codebase relies on cross-call effect ordering, don't enable the auto-fix blindly.

## Install

```sh
npm install --save-dev eslint-plugin-parallelize
```

## Usage (flat config)

```js
// eslint.config.js
import parallelize from 'eslint-plugin-parallelize';

export default [
  {
    plugins: { parallelize },
    rules: {
      'parallelize/no-sequential-await': 'warn',
    },
  },
];
```

Or use the bundled config: `parallelize.configs.recommended`.

## How it works

### Statement runs

The rule scans each block for maximal runs of consecutive await statements in these forms:

```js
await foo();              // expression
const x = await foo();    // declaration (any destructuring pattern)
x = await foo();          // assignment (incl. obj.prop = await foo())
```

Within a run it builds a data-dependency graph using ESLint's scope analysis — identifier references are resolved to their actual variables, so shadowing, closures, destructuring defaults, and callback parameters are handled exactly. Statement B depends on statement A when any of:

- **read-after-write** — B reads a variable A writes (`const a = await f(); await g(a)`)
- **write-after-read** — B writes a variable A reads
- **write-after-write** — B writes a variable A writes

Property writes (`obj.x = await f()`) are conservatively treated as writes to `obj`. Untrackable targets (`this.x`, `f().x`) make the statement an ordering barrier.

Statements are then layered by longest path in the dependency graph. Any layer with two or more statements is available parallelism, and the layering *is* the fix:

```js
// before: a ─→ b, a ─→ c, {b,c} ─→ d
const a = await f();
const b = await g(a);
const c = await h(a);
const d = await i(b, c);

// after --fix
const a = await f();
const [b, c] = await Promise.all([g(a), h(a)]);
const d = await i(b, c);
```

Statements in the same layer may be reordered relative to dependent statements between them — this is safe exactly because the dependency analysis proved them independent.

### Boolean logic

Short-circuit operators serialize awaits too:

```js
const ok = await isAdmin(user) && await hasQuota(user);
```

`hasQuota` doesn't start until `isAdmin` resolves. With side-effect-free operands the parallel form is equivalent (`&&`/`||`/`??` become plain boolean combination once both values are in hand):

```js
const [admin, quota] = await Promise.all([isAdmin(user), hasQuota(user)]);
const ok = admin && quota;
```

The rule reports multi-await `&&`/`||`/`??` trees (message only — the rewrite needs new bindings, so it isn't auto-fixed). Expressions where one operand's assignment feeds another (`(x = await f()) && await g(x)`) are left alone.

### When parallelizing wouldn't help

Awaiting an **already in-flight** promise sequentially costs nothing — the work is already running:

```js
await p1;   // p1 was started earlier
await p2;   // fine: total time is max(p1, p2) either way
```

The rule only reports when some await *after the first in its group* actually starts new work (contains a call, `new`, tagged template, or dynamic `import()`). So `await p1; await foo();` is reported (foo could have started immediately), but `await foo(); await p1;` is not.

### When the fix is withheld

The rule still reports, but won't auto-fix, when a faithful single-statement rewrite doesn't exist:

- assignments to existing bindings (`x = await f()`) — would need to invent temporaries
- mixed `const`/`let` in one group
- comments between the statements (they'd be destroyed)

## Options

```jsonc
{
  "parallelize/no-sequential-await": ["warn", { "ignoreTry": false }]
}
```

- `ignoreTry` (default `false`) — skip blocks directly inside `try`/`catch`/`finally`. `Promise.all` is fail-fast and starts every operation regardless of which one throws, which can matter for carefully staged error handling even without side effects.

## Semantics changed by the fix

Even with side-effect-free operations, two observable differences exist:

1. **Failure timing/selection**: sequentially, a rejection in the first await prevents later calls from ever starting. After the fix, all calls start; `Promise.all` rejects with the *first* rejection to settle. (`Promise.all` does subscribe to every promise, so no unhandled-rejection warnings.)
2. **Resource pressure**: N concurrent calls instead of 1 at a time (connection pools, rate limits).

Both are almost always acceptable — and usually desirable — under the no-side-effects assumption, but it's why `ignoreTry` exists.

## Limitations (v0.1)

- Statement-level only: `export const a = await f()`, multi-declarator statements, `return await f()`, and statements containing nested awaits (`await f(await g())`) act as barriers rather than being analyzed.
- No alias analysis: `a.x = await f(); b.y = await g()` is considered independent when `a` and `b` are distinct variables, even if they alias the same object.
- No interprocedural analysis: a helper that internally awaits sequentially won't be seen.
- Purely syntactic promise detection: no type information is used (and none is needed for the core analysis — `await` itself marks the async boundary). A future type-aware mode (via typescript-eslint services) could catch promise-returning calls that are serialized without `await`, and thenables with side-effectful getters.
- Ternaries (`await c() ? x : y`) and loop-carried parallelism (`no-await-in-loop` territory) are out of scope for now.

## Prior art

Nothing existing does dependency-aware detection of serializable awaits:

- [`no-await-in-loop`](https://eslint.org/docs/latest/rules/no-await-in-loop) (ESLint core) — loops only, no dependency analysis.
- [eslint/eslint#17824](https://github.com/eslint/eslint/discussions/17824) and [typescript-eslint#8098](https://github.com/typescript-eslint/typescript-eslint/issues/8098) — the *opposite* concern (don't hold pending promises too long before awaiting).
- [`eslint-plugin-promise`](https://www.npmjs.com/package/eslint-plugin-promise) — promise hygiene, not scheduling.

## License

MIT
