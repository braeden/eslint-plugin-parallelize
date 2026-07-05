import { ESLintUtils, TSESLint, TSESTree } from '@typescript-eslint/utils';
import type * as ts from 'typescript';

/**
 * Flags sequences of `await` statements (and boolean expressions containing
 * multiple `await`s) whose async operations have no data dependency on each
 * other, and therefore could run concurrently. Loops whose awaits carry no
 * dependency between iterations are flagged too.
 *
 * Dependency analysis is name-exact: it uses ESLint's scope manager to resolve
 * every identifier reference to its variable, classifying reads and writes per
 * statement. A statement B depends on an earlier statement A when:
 *   - B reads a variable A writes (read-after-write),
 *   - B writes a variable A reads (write-after-read), or
 *   - B writes a variable A writes (write-after-write).
 * Property writes (`obj.x = await f()`) are treated conservatively as writes
 * to the base object variable. Statements whose write target can't be tracked
 * (`this.x = ...`, `f().x = ...`) act as ordering barriers.
 *
 * Statements are then assigned to dependency levels (longest-path layering);
 * any level containing two or more awaits means available parallelism, and the
 * layering itself becomes the auto-fix.
 *
 * When the consumer parses with @typescript-eslint and type information is
 * available (parserOptions.projectService / project), the rule upgrades
 * automatically:
 *   - `await` of a call whose type is not thenable no longer counts as
 *     starting async work (awaiting sync values gains nothing from
 *     Promise.all), and
 *   - declarations of un-awaited thenables (`const p = fetchB();`) stop being
 *     run barriers: they join the dependency analysis, letting runs group
 *     across them.
 * `any`/`unknown` types keep the syntactic behavior, so untyped code is not
 * silently under-reported.
 */

const FUNCTION_TYPES = new Set<TSESTree.AST_NODE_TYPES | string>([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const LOOP_TYPES = new Set<TSESTree.AST_NODE_TYPES | string>([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

const DECL_KINDS = new Set(['var', 'let', 'const']);

// ts.TypeFlags.Any | ts.TypeFlags.Unknown — literal so `typescript` stays an
// optional, type-only dependency.
const ANY_OR_UNKNOWN_FLAGS = 3;

type RefKey = TSESLint.Scope.Variable | string;

interface Refs {
  reads: Set<RefKey>;
  writes: Set<RefKey>;
  identKey: Map<TSESTree.Node, RefKey>;
}

type Form = 'expr' | 'decl' | 'assign' | 'promise-start';

interface StatementInfo {
  stmt: TSESTree.Statement;
  form: Form;
  kind: string | null;
  reads: Set<RefKey>;
  writes: Set<RefKey>;
  opaque: boolean;
  startsWork: boolean;
  exprText: string | null;
  patternText: string | null;
}

type Options = [
  {
    ignoreTry?: boolean;
    checkLoops?: boolean;
  }?,
];

type MessageIds = 'independent' | 'partial' | 'booleanLogic' | 'loopSequential';

const createRule = ESLintUtils.RuleCreator(
  () => 'https://github.com/braeden/eslint-plugin-parallelize#readme'
);

export default createRule<Options, MessageIds>({
  name: 'no-sequential-await',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow sequentially awaiting independent async operations; prefer running them concurrently (e.g. Promise.all)',
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          ignoreTry: { type: 'boolean' },
          checkLoops: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      independent:
        'These {{count}} awaited operations are independent of each other — run them concurrently with Promise.all instead of awaiting them sequentially.',
      partial:
        '{{parallel}} of these {{count}} sequentially awaited operations are mutually independent — group the independent ones with Promise.all for maximal concurrency.',
      booleanLogic:
        'This boolean expression awaits {{count}} independent operations sequentially (short-circuit evaluation) — await them together first (e.g. `const [a, b] = await Promise.all([...])`), then combine the results.',
      loopSequential:
        'Each iteration of this loop awaits work that does not depend on previous iterations — the loop serializes independent async operations. Collect the promises and `await Promise.all(...)` (or use a concurrency-limited map) instead.',
    },
  },
  defaultOptions: [{}],

  create(context, [options]) {
    const sourceCode = context.sourceCode;
    const ignoreTry = options?.ignoreTry === true;
    const checkLoops = options?.checkLoops !== false;
    const visitorKeys = sourceCode.visitorKeys;

    // Type information, when the parser provides it (typescript-eslint with
    // projectService/project). Absent under espree or without type info.
    const services = sourceCode.parserServices;
    const program = services?.program ?? null;
    const nodeMap = services?.esTreeNodeToTSNodeMap ?? null;
    const checker = program && nodeMap ? program.getTypeChecker() : null;

    function isNode(value: unknown): value is TSESTree.Node {
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { type?: unknown }).type === 'string'
      );
    }

    /** Generic AST walk using the parser's visitor keys. `visit` may return
     *  false to skip a node's children. */
    function traverse(
      root: TSESTree.Node,
      visit: (node: TSESTree.Node) => boolean | undefined
    ): void {
      if (visit(root) === false) {
        return;
      }
      for (const key of visitorKeys[root.type] ?? []) {
        const child = (root as unknown as Record<string, unknown>)[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (isNode(c)) {
              traverse(c, visit);
            }
          }
        } else if (isNode(child)) {
          traverse(child, visit);
        }
      }
    }

    /** Count AwaitExpressions that execute as part of this node itself
     *  (i.e. not inside a nested function body). */
    function countAwaits(root: TSESTree.Node): number {
      let count = 0;
      traverse(root, (n) => {
        if (n !== root && FUNCTION_TYPES.has(n.type)) {
          return false;
        }
        if (n.type === 'AwaitExpression') {
          count += 1;
        }
        return undefined;
      });
      return count;
    }

    function containsCall(root: TSESTree.Node): boolean {
      let found = false;
      traverse(root, (n) => {
        if (FUNCTION_TYPES.has(n.type)) {
          return false;
        }
        if (
          n.type === 'CallExpression' ||
          n.type === 'NewExpression' ||
          n.type === 'TaggedTemplateExpression' ||
          n.type === 'ImportExpression'
        ) {
          found = true;
        }
        return undefined;
      });
      return found;
    }

    /** 'thenable' | 'sync' | 'unknown' for the expression's static type.
     *  'unknown' (no type info, any, unknown, errors) preserves the purely
     *  syntactic behavior. */
    function typeKind(node: TSESTree.Node): 'thenable' | 'sync' | 'unknown' {
      if (!checker || !nodeMap) {
        return 'unknown';
      }
      const tsNode = nodeMap.get(node);
      if (!tsNode) {
        return 'unknown';
      }
      let type: ts.Type;
      try {
        type = checker.getTypeAtLocation(tsNode);
      } catch {
        return 'unknown';
      }
      const parts = type.isUnion() ? type.types : [type];
      let sawAnyish = false;
      for (const part of parts) {
        if ((part.flags & ANY_OR_UNKNOWN_FLAGS) !== 0) {
          sawAnyish = true;
          continue;
        }
        const then = part.getProperty('then');
        if (!then) {
          continue;
        }
        const thenType = checker.getTypeOfSymbolAtLocation(then, tsNode);
        const thenParts = thenType.isUnion() ? thenType.types : [thenType];
        if (thenParts.some((t) => t.getCallSignatures().length > 0)) {
          return 'thenable';
        }
      }
      return sawAnyish ? 'unknown' : 'sync';
    }

    /** Whether evaluating this expression starts new async work. Requires a
     *  call syntactically; with type info, calls that produce non-thenables
     *  don't count (awaiting a sync value gains nothing from grouping). */
    function startsAsyncWork(expr: TSESTree.Node): boolean {
      return containsCall(expr) && typeKind(expr) !== 'sync';
    }

    function containsMutation(root: TSESTree.Node): boolean {
      let found = false;
      traverse(root, (n) => {
        if (
          n.type === 'AssignmentExpression' ||
          n.type === 'UpdateExpression' ||
          (n.type === 'UnaryExpression' && n.operator === 'delete')
        ) {
          found = true;
        }
        return undefined;
      });
      return found;
    }

    const within = (
      inner: Readonly<TSESTree.Range>,
      outer: Readonly<TSESTree.Range>
    ): boolean => inner[0] >= outer[0] && inner[1] <= outer[1];

    let cachedRefs: TSESLint.Scope.Reference[] | null = null;
    function getAllReferences(): TSESLint.Scope.Reference[] {
      if (!cachedRefs) {
        cachedRefs = [];
        const scopeManager = sourceCode.scopeManager;
        if (scopeManager) {
          for (const scope of scopeManager.scopes) {
            for (const ref of scope.references) {
              cachedRefs.push(ref);
            }
          }
        }
      }
      return cachedRefs;
    }

    /**
     * Classify every identifier reference inside `range` as a read and/or
     * write of a variable. Variables that live entirely inside the range
     * (callback params, statement-local temps) are ignored — they cannot
     * carry a dependency to another statement.
     */
    function classifyReferences(range: Readonly<TSESTree.Range>): Refs {
      const reads = new Set<RefKey>();
      const writes = new Set<RefKey>();
      const identKey = new Map<TSESTree.Node, RefKey>();
      for (const ref of getAllReferences()) {
        const id = ref.identifier;
        if (!within(id.range, range)) {
          continue;
        }
        const variable = ref.resolved;
        if (
          variable &&
          variable.defs.length > 0 &&
          variable.defs.every((d) => within(d.name.range, range)) &&
          variable.references.every((r) => within(r.identifier.range, range))
        ) {
          continue; // variable is local to this range
        }
        const key: RefKey = variable ?? `g:${id.name}`;
        identKey.set(id, key);
        if (ref.isRead()) {
          reads.add(key);
        }
        if (ref.isWrite()) {
          writes.add(key);
        }
      }
      return { reads, writes, identKey };
    }

    /** Record property writes (obj.x = ..., obj.x++, delete obj.x) as writes
     *  to the base object's variable. Untrackable bases (this.x, f().x) make
     *  the statement an ordering barrier via the returned `opaque` flag. */
    function collectMemberWrites(root: TSESTree.Node, refs: Refs): boolean {
      let opaque = false;
      traverse(root, (n) => {
        let target: TSESTree.MemberExpression | null = null;
        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
          target = n.left;
        } else if (n.type === 'UpdateExpression' && n.argument.type === 'MemberExpression') {
          target = n.argument;
        } else if (
          n.type === 'UnaryExpression' &&
          n.operator === 'delete' &&
          n.argument.type === 'MemberExpression'
        ) {
          target = n.argument;
        }
        if (!target) {
          return undefined;
        }
        let base: TSESTree.Node = target.object;
        for (;;) {
          if (base.type === 'MemberExpression') {
            base = base.object;
          } else if (base.type === 'ChainExpression') {
            base = base.expression;
          } else {
            break;
          }
        }
        if (base.type === 'Identifier') {
          refs.writes.add(refs.identKey.get(base) ?? `g:${base.name}`);
        } else {
          opaque = true;
        }
        return undefined;
      });
      return opaque;
    }

    /** Pattern text without a TS type annotation (`a: number` → `a`); the
     *  annotation can't survive inside a combined destructuring pattern. */
    function patternTextOf(pattern: TSESTree.Node): string {
      const annotation = (pattern as { typeAnnotation?: TSESTree.Node }).typeAnnotation;
      if (!annotation) {
        return sourceCode.getText(pattern);
      }
      return sourceCode.getText().slice(pattern.range[0], annotation.range[0]);
    }

    /**
     * Recognize the statement forms the sequence analysis understands:
     *   expr:          await foo();
     *   decl:          const x = await foo();
     *   assign:        x = await foo();   /   obj.x = await foo();
     *   promise-start: const p = foo();   (type-aware only: thenable, no await)
     * Anything else is a run barrier.
     */
    function analyzeStatement(stmt: TSESTree.Statement): StatementInfo | null {
      let form: Form;
      let awaitNode: TSESTree.AwaitExpression | null = null;
      let patternNode: TSESTree.Node | null = null;
      let kind: string | null = null;
      let initNode: TSESTree.Expression | null = null;

      if (stmt.type === 'ExpressionStatement') {
        const e = stmt.expression;
        if (e.type === 'AwaitExpression') {
          form = 'expr';
          awaitNode = e;
        } else if (
          e.type === 'AssignmentExpression' &&
          e.operator === '=' &&
          e.right.type === 'AwaitExpression'
        ) {
          form = 'assign';
          awaitNode = e.right;
          patternNode = e.left;
        } else {
          return null;
        }
      } else if (
        stmt.type === 'VariableDeclaration' &&
        DECL_KINDS.has(stmt.kind) &&
        stmt.declarations.length === 1 &&
        stmt.declarations[0].init
      ) {
        const init = stmt.declarations[0].init;
        if (init.type === 'AwaitExpression') {
          form = 'decl';
          awaitNode = init;
          patternNode = stmt.declarations[0].id;
          kind = stmt.kind;
        } else if (
          checker &&
          countAwaits(stmt) === 0 &&
          containsCall(init) &&
          typeKind(init) === 'thenable'
        ) {
          // Un-awaited promise creation: already concurrent, and (being
          // side-effect free) safe to analyze rather than treat as a barrier.
          form = 'promise-start';
          patternNode = stmt.declarations[0].id;
          kind = stmt.kind;
          initNode = init;
        } else {
          return null;
        }
      } else {
        return null;
      }

      if (form !== 'promise-start' && countAwaits(stmt) !== 1) {
        return null;
      }

      const refs = classifyReferences(stmt.range);
      let opaque = collectMemberWrites(stmt, refs);

      // Destructuring assignment onto properties ([a.x] = await f()) — the
      // property writes hide inside the pattern; treat as a barrier.
      if (
        patternNode &&
        (patternNode.type === 'ArrayPattern' || patternNode.type === 'ObjectPattern')
      ) {
        traverse(patternNode, (n) => {
          if (n.type === 'MemberExpression') {
            opaque = true;
          }
          return undefined;
        });
      }

      let exprText: string | null = null;
      let startsWork = false;
      if (awaitNode) {
        const argument = awaitNode.argument;
        exprText = sourceCode.getText(argument);
        if (argument.type === 'SequenceExpression') {
          exprText = `(${exprText})`;
        }
        startsWork = startsAsyncWork(argument);
      } else if (initNode) {
        startsWork = false; // already started; grouping gains nothing
      }

      return {
        stmt,
        form,
        kind,
        reads: refs.reads,
        writes: refs.writes,
        opaque,
        startsWork,
        exprText,
        patternText: patternNode ? patternTextOf(patternNode) : null,
      };
    }

    function intersects(a: Set<RefKey>, b: Set<RefKey>): boolean {
      for (const item of a) {
        if (b.has(item)) {
          return true;
        }
      }
      return false;
    }

    function conflicts(earlier: StatementInfo, later: StatementInfo): boolean {
      return (
        earlier.opaque ||
        later.opaque ||
        intersects(later.reads, earlier.writes) || // read-after-write
        intersects(later.writes, earlier.reads) || // write-after-read
        intersects(later.writes, earlier.writes) // write-after-write
      );
    }

    /** Longest-path layering: level 1 = no deps within the run; level n =
     *  depends on something at level n-1. Statements sharing a level are
     *  mutually independent (any dependency forces a higher level). */
    function computeLevels(run: StatementInfo[]): number[] {
      const levels: number[] = new Array(run.length).fill(1) as number[];
      for (let j = 1; j < run.length; j++) {
        for (let i = 0; i < j; i++) {
          if (conflicts(run[i], run[j])) {
            levels[j] = Math.max(levels[j], levels[i] + 1);
          }
        }
      }
      return levels;
    }

    /** Build the layered Promise.all rewrite, or null when it can't be done
     *  faithfully (assignment forms, mixed declaration kinds, interleaved
     *  comments). Promise-start statements are emitted verbatim at the top of
     *  their level — they already run concurrently. */
    function buildReplacement(run: StatementInfo[], groups: number[][]): string | null {
      for (let i = 1; i < run.length; i++) {
        if (sourceCode.getCommentsBefore(run[i].stmt).length > 0) {
          return null;
        }
      }

      const lines: string[] = [];
      for (let level = 1; level < groups.length; level++) {
        const group = groups[level];
        if (!group) {
          continue;
        }
        const members = group.map((idx) => run[idx]);
        const starts = members.filter((m) => m.form === 'promise-start');
        const awaited = members.filter((m) => m.form !== 'promise-start');
        for (const s of starts) {
          lines.push(sourceCode.getText(s.stmt));
        }
        if (awaited.length === 0) {
          continue;
        }
        if (awaited.length === 1) {
          lines.push(sourceCode.getText(awaited[0].stmt));
          continue;
        }
        if (awaited.some((m) => m.form === 'assign')) {
          return null;
        }
        const exprs = awaited.map((m) => m.exprText).join(', ');
        const declMembers = awaited.filter((m) => m.form === 'decl');
        if (declMembers.length === 0) {
          lines.push(`await Promise.all([${exprs}]);`);
          continue;
        }
        const kinds = new Set(declMembers.map((m) => m.kind));
        if (kinds.size > 1) {
          return null;
        }
        const patterns = awaited.map((m) => m.patternText ?? '');
        while (patterns.length > 0 && patterns[patterns.length - 1] === '') {
          patterns.pop();
        }
        lines.push(
          `${declMembers[0].kind} [${patterns.join(', ')}] = await Promise.all([${exprs}]);`
        );
      }

      const first = run[0].stmt;
      const linePrefix = sourceCode.lines[first.loc.start.line - 1].slice(
        0,
        first.loc.start.column
      );
      const indent = /^\s*$/.test(linePrefix) ? linePrefix : '';
      return lines.join(`\n${indent}`);
    }

    function checkRun(run: StatementInfo[]): void {
      if (run.length < 2) {
        return;
      }
      const levels = computeLevels(run);
      const groups: number[][] = [];
      for (let idx = 0; idx < run.length; idx++) {
        (groups[levels[idx]] ??= []).push(idx);
      }

      const isAwaited = (idx: number): boolean => run[idx].form !== 'promise-start';
      const awaitedTotal = run.filter((m) => m.form !== 'promise-start').length;
      const multiGroups = groups.filter((g) => g && g.filter(isAwaited).length >= 2);

      // Parallelizing only pays off when a group would start new work earlier:
      // some non-first awaited member must actually kick something off.
      // Awaiting already-in-flight promises sequentially costs nothing extra.
      const beneficial = multiGroups.some((g) =>
        g.filter(isAwaited).slice(1).some((idx) => run[idx].startsWork)
      );
      if (!beneficial) {
        return;
      }

      const parallel = multiGroups.reduce((sum, g) => sum + g.filter(isAwaited).length, 0);
      const fullyIndependent = multiGroups.length === 1 && parallel === awaitedTotal;
      const replacement = buildReplacement(run, groups);
      const firstStmt = run[0].stmt;
      const lastStmt = run[run.length - 1].stmt;

      context.report({
        node: firstStmt,
        loc: { start: firstStmt.loc.start, end: lastStmt.loc.end },
        messageId: fullyIndependent ? 'independent' : 'partial',
        data: { count: String(awaitedTotal), parallel: String(parallel) },
        fix:
          replacement === null
            ? null
            : (fixer) =>
                fixer.replaceTextRange([firstStmt.range[0], lastStmt.range[1]], replacement),
      });
    }

    function processBody(body: TSESTree.Statement[]): void {
      let run: StatementInfo[] = [];
      for (const stmt of body) {
        const info = analyzeStatement(stmt);
        if (info) {
          run.push(info);
        } else {
          checkRun(run);
          run = [];
        }
      }
      checkRun(run);
    }

    /**
     * Loop analysis: an await inside a loop serializes across iterations.
     * That is only necessary when the await (or the decision to keep looping)
     * depends on data produced by a previous iteration — e.g. a paging token.
     * Approximated with a taint pass: variables written by await-containing
     * units are tainted, propagating through assignments to a fixpoint.
     */
    function isLiteralTrue(n: TSESTree.Node | null | undefined): boolean {
      return n != null && n.type === 'Literal' && n.value === true;
    }

    interface Unit {
      reads: Set<RefKey>;
      writes: Set<RefKey>;
      hasAwait: boolean;
      opaque: boolean;
    }

    function collectUnit(n: TSESTree.Node): Unit {
      const refs = classifyReferences(n.range);
      const opaque = collectMemberWrites(n, refs);
      return {
        reads: refs.reads,
        writes: refs.writes,
        hasAwait: countAwaits(n) > 0,
        opaque,
      };
    }

    type LoopNode =
      | TSESTree.ForStatement
      | TSESTree.ForInStatement
      | TSESTree.ForOfStatement
      | TSESTree.WhileStatement
      | TSESTree.DoWhileStatement;

    function checkLoop(node: LoopNode): void {
      if (!checkLoops) {
        return;
      }
      if (node.type === 'ForOfStatement' && node.await) {
        return;
      }
      const test = node.type === 'ForInStatement' || node.type === 'ForOfStatement' ? null : node.test;
      if (
        (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') &&
        isLiteralTrue(test)
      ) {
        return;
      }
      if (node.type === 'ForStatement' && (!test || isLiteralTrue(test))) {
        return;
      }

      // Awaits belonging to this loop: directly executing in the body, not
      // inside nested functions or nested loops (those report on their own).
      const awaits: TSESTree.AwaitExpression[] = [];
      traverse(node.body, (n) => {
        if (FUNCTION_TYPES.has(n.type) || LOOP_TYPES.has(n.type)) {
          return false;
        }
        if (n.type === 'AwaitExpression') {
          awaits.push(n);
          return false;
        }
        return undefined;
      });
      if (awaits.length === 0) {
        return;
      }
      if (test && countAwaits(test) > 0) {
        return;
      }

      const units: Unit[] = [];
      let opaque = false;
      traverse(node, (n) => {
        if (
          (n.type === 'VariableDeclarator' && n.init) ||
          n.type === 'AssignmentExpression' ||
          n.type === 'UpdateExpression'
        ) {
          const unit = collectUnit(n);
          opaque = opaque || unit.opaque;
          units.push(unit);
        }
        return undefined;
      });
      if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
        units.push({
          reads: classifyReferences(node.right.range).reads,
          writes: classifyReferences(node.left.range).writes,
          hasAwait: countAwaits(node.right) > 0,
          opaque: false,
        });
      }
      if (opaque) {
        return;
      }

      const tainted = new Set<RefKey>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const unit of units) {
          if (!unit.hasAwait && !intersects(unit.reads, tainted)) {
            continue;
          }
          for (const w of unit.writes) {
            if (!tainted.has(w)) {
              tainted.add(w);
              changed = true;
            }
          }
        }
      }

      if (test && intersects(classifyReferences(test.range).reads, tainted)) {
        return;
      }

      let guardedExit = false;
      traverse(node.body, (n) => {
        if (guardedExit || FUNCTION_TYPES.has(n.type)) {
          return false;
        }
        if (
          n.type === 'BreakStatement' ||
          n.type === 'ContinueStatement' ||
          n.type === 'ReturnStatement' ||
          n.type === 'ThrowStatement'
        ) {
          for (let p: TSESTree.Node | undefined = n.parent; p && p !== node; p = p.parent) {
            let cond: TSESTree.Node | null = null;
            if (
              p.type === 'IfStatement' ||
              p.type === 'ConditionalExpression' ||
              p.type === 'WhileStatement' ||
              p.type === 'DoWhileStatement' ||
              (p.type === 'ForStatement' && p.test)
            ) {
              cond = p.test ?? null;
            } else if (p.type === 'SwitchStatement') {
              cond = p.discriminant;
            }
            if (cond && intersects(classifyReferences(cond.range).reads, tainted)) {
              guardedExit = true;
              break;
            }
          }
        }
        return undefined;
      });
      if (guardedExit) {
        return;
      }

      const target = awaits.find(
        (a) =>
          startsAsyncWork(a.argument) &&
          !intersects(classifyReferences(a.range).reads, tainted)
      );
      if (target) {
        context.report({ node: target, messageId: 'loopSequential' });
      }
    }

    /** Boolean-logic mixes: `await a() && await b()` executes sequentially due
     *  to short-circuit evaluation. With side-effect-free operands, awaiting
     *  the operands concurrently and combining the booleans afterwards is
     *  equivalent and faster. Reported at the topmost logical expression. */
    function checkLogical(node: TSESTree.LogicalExpression): void {
      if (node.parent && node.parent.type === 'LogicalExpression') {
        return;
      }
      const awaits: TSESTree.AwaitExpression[] = [];
      traverse(node, (n) => {
        if (FUNCTION_TYPES.has(n.type)) {
          return false;
        }
        if (n.type === 'AwaitExpression') {
          awaits.push(n);
          return false; // nested awaits belong to this operand's unit of work
        }
        return undefined;
      });
      if (awaits.length < 2) {
        return;
      }
      // A mutation anywhere in the tree could carry a dependency between
      // operands (e.g. `(x = await f()) && await g(x)`); stay silent.
      if (containsMutation(node)) {
        return;
      }
      if (!awaits.slice(1).some((a) => startsAsyncWork(a.argument))) {
        return;
      }
      context.report({
        node,
        messageId: 'booleanLogic',
        data: { count: String(awaits.length) },
      });
    }

    return {
      Program(node): void {
        processBody(node.body);
      },
      BlockStatement(node): void {
        if (
          ignoreTry &&
          node.parent &&
          (node.parent.type === 'TryStatement' || node.parent.type === 'CatchClause')
        ) {
          return;
        }
        processBody(node.body);
      },
      SwitchCase(node): void {
        processBody(node.consequent);
      },
      LogicalExpression: checkLogical,
      // :exit so parent pointers exist throughout the subtree.
      'ForStatement:exit': checkLoop,
      'ForInStatement:exit': checkLoop,
      'ForOfStatement:exit': checkLoop,
      'WhileStatement:exit': checkLoop,
      'DoWhileStatement:exit': checkLoop,
    };
  },
});
