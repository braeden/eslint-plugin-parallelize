'use strict';

/**
 * Flags sequences of `await` statements (and boolean expressions containing
 * multiple `await`s) whose async operations have no data dependency on each
 * other, and therefore could run concurrently.
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
 * layering itself becomes the suggested Promise.all rewrite.
 */

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const DECL_KINDS = new Set(['var', 'let', 'const']);

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

module.exports = {
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

  create(context) {
    const sourceCode = context.sourceCode;
    const options = context.options[0] || {};
    const ignoreTry = options.ignoreTry === true;
    const checkLoops = options.checkLoops !== false;
    const visitorKeys = sourceCode.visitorKeys;

    /** Generic AST walk using the parser's visitor keys. `visit` may return
     *  false to skip a node's children. */
    function traverse(node, visit) {
      if (visit(node) === false) {
        return;
      }
      for (const key of visitorKeys[node.type] || []) {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c.type === 'string') {
              traverse(c, visit);
            }
          }
        } else if (child && typeof child.type === 'string') {
          traverse(child, visit);
        }
      }
    }

    /** Count AwaitExpressions that execute as part of this node itself
     *  (i.e. not inside a nested function body). */
    function countAwaits(root) {
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

    /** Whether evaluating this expression starts new work (contains a call).
     *  `await somePromiseVariable` starts nothing — it is already in flight —
     *  so serializing it after another await costs nothing. */
    function containsCall(root) {
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

    function containsMutation(root) {
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

    const within = (inner, outer) => inner[0] >= outer[0] && inner[1] <= outer[1];

    let cachedRefs = null;
    function getAllReferences() {
      if (!cachedRefs) {
        cachedRefs = [];
        for (const scope of sourceCode.scopeManager.scopes) {
          for (const ref of scope.references) {
            cachedRefs.push(ref);
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
     *
     * Returns { reads, writes, identKey } where reads/writes are Sets keyed
     * by the resolved Variable object (or 'g:<name>' for globals), and
     * identKey maps each in-range Identifier node to its key.
     */
    function classifyReferences(range) {
      const reads = new Set();
      const writes = new Set();
      const identKey = new Map();
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
        const key = variable || `g:${id.name}`;
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
     *  the statement an ordering barrier via `opaque`. */
    function collectMemberWrites(root, refs) {
      let opaque = false;
      traverse(root, (n) => {
        let target = null;
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
        let base = target.object;
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
          refs.writes.add(refs.identKey.get(base) || `g:${base.name}`);
        } else {
          opaque = true;
        }
        return undefined;
      });
      return opaque;
    }

    /**
     * Recognize the statement forms the sequence analysis understands:
     *   expr:    await foo();
     *   decl:    const x = await foo();
     *   assign:  x = await foo();   /   obj.x = await foo();
     * Anything else — including statements with more or fewer than exactly
     * one directly-executing await — is a run barrier.
     */
    function analyzeStatement(stmt) {
      let form;
      let awaitNode;
      let patternNode = null;
      let kind = null;

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
        stmt.declarations[0].init &&
        stmt.declarations[0].init.type === 'AwaitExpression'
      ) {
        form = 'decl';
        awaitNode = stmt.declarations[0].init;
        patternNode = stmt.declarations[0].id;
        kind = stmt.kind;
      } else {
        return null;
      }

      if (countAwaits(stmt) !== 1) {
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

      const argument = awaitNode.argument;
      let exprText = sourceCode.getText(argument);
      if (argument.type === 'SequenceExpression') {
        exprText = `(${exprText})`;
      }

      return {
        stmt,
        form,
        kind,
        reads: refs.reads,
        writes: refs.writes,
        opaque,
        hasCall: containsCall(argument),
        exprText,
        patternText: patternNode ? sourceCode.getText(patternNode) : null,
      };
    }

    function intersects(a, b) {
      for (const item of a) {
        if (b.has(item)) {
          return true;
        }
      }
      return false;
    }

    function conflicts(earlier, later) {
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
    function computeLevels(run) {
      const levels = new Array(run.length).fill(1);
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
     *  comments). */
    function buildReplacement(run, groups) {
      for (let i = 1; i < run.length; i++) {
        if (sourceCode.getCommentsBefore(run[i].stmt).length > 0) {
          return null;
        }
      }

      const lines = [];
      for (let level = 1; level < groups.length; level++) {
        const group = groups[level];
        if (!group) {
          continue;
        }
        if (group.length === 1) {
          lines.push(sourceCode.getText(run[group[0]].stmt));
          continue;
        }
        const members = group.map((idx) => run[idx]);
        if (members.some((m) => m.form === 'assign')) {
          return null;
        }
        const exprs = members.map((m) => m.exprText).join(', ');
        const declMembers = members.filter((m) => m.form === 'decl');
        if (declMembers.length === 0) {
          lines.push(`await Promise.all([${exprs}]);`);
          continue;
        }
        const kinds = new Set(declMembers.map((m) => m.kind));
        if (kinds.size > 1) {
          return null;
        }
        const patterns = members.map((m) => m.patternText || '');
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

    function checkRun(run) {
      if (run.length < 2) {
        return;
      }
      const levels = computeLevels(run);
      const groups = [];
      for (let idx = 0; idx < run.length; idx++) {
        (groups[levels[idx]] = groups[levels[idx]] || []).push(idx);
      }

      const multiGroups = groups.filter((g) => g && g.length >= 2);
      // Parallelizing only pays off when a group would start new work earlier:
      // some non-first member must actually kick something off. Awaiting
      // already-in-flight promises sequentially costs nothing extra.
      const beneficial = multiGroups.some((g) =>
        g.slice(1).some((idx) => run[idx].hasCall)
      );
      if (!beneficial) {
        return;
      }

      const parallel = multiGroups.reduce((sum, g) => sum + g.length, 0);
      const fullyIndependent = multiGroups.length === 1 && multiGroups[0].length === run.length;
      const replacement = buildReplacement(run, groups);
      const firstStmt = run[0].stmt;
      const lastStmt = run[run.length - 1].stmt;

      context.report({
        node: firstStmt,
        loc: { start: firstStmt.loc.start, end: lastStmt.loc.end },
        messageId: fullyIndependent ? 'independent' : 'partial',
        data: { count: String(run.length), parallel: String(parallel) },
        fix:
          replacement === null
            ? null
            : (fixer) =>
                fixer.replaceTextRange(
                  [firstStmt.range[0], lastStmt.range[1]],
                  replacement
                ),
      });
    }

    function processBody(body) {
      let run = [];
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
     * That is only necessary when the await (or the decision to keep
     * looping) depends on data produced by a previous iteration — e.g. a
     * paging token. We approximate "produced by a previous iteration" with
     * a taint pass: variables written by await-containing units are tainted,
     * and taint propagates through assignments to a fixpoint. The loop is
     * left alone when:
     *   - a reported await's inputs read tainted state (paging, folds), or
     *   - the loop condition reads tainted state or itself awaits (retry,
     *     polling protocols), or
     *   - a break/continue/return/throw is guarded by a tainted condition
     *     (poll-until-done protocols), or
     *   - the loop is `while (true)` / `for (;;)` (daemons), `for await`,
     *     or contains an untrackable property write (`this.x = ...`).
     */
    function isLiteralTrue(n) {
      return n !== null && n !== undefined && n.type === 'Literal' && n.value === true;
    }

    function collectUnit(n) {
      const refs = classifyReferences(n.range);
      const opaque = collectMemberWrites(n, refs);
      return {
        reads: refs.reads,
        writes: refs.writes,
        hasAwait: countAwaits(n) > 0,
        opaque,
      };
    }

    function checkLoop(node) {
      if (!checkLoops) {
        return;
      }
      if (node.type === 'ForOfStatement' && node.await) {
        return;
      }
      if (
        (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') &&
        isLiteralTrue(node.test)
      ) {
        return;
      }
      if (node.type === 'ForStatement' && (!node.test || isLiteralTrue(node.test))) {
        return;
      }

      // Awaits belonging to this loop: directly executing in the body, not
      // inside nested functions or nested loops (those report on their own).
      const awaits = [];
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
      if (node.test && countAwaits(node.test) > 0) {
        return;
      }

      // Taint pass over every assignment-like unit in the loop (including
      // nested functions and loops — mutations anywhere are conservative
      // dependency carriers).
      const units = [];
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

      const tainted = new Set();
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

      if (node.test && intersects(classifyReferences(node.test.range).reads, tainted)) {
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
          for (let p = n.parent; p && p !== node; p = p.parent) {
            let cond = null;
            if (
              p.type === 'IfStatement' ||
              p.type === 'ConditionalExpression' ||
              p.type === 'WhileStatement' ||
              p.type === 'DoWhileStatement' ||
              (p.type === 'ForStatement' && p.test)
            ) {
              cond = p.test;
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
          containsCall(a.argument) &&
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
    function checkLogical(node) {
      if (node.parent && node.parent.type === 'LogicalExpression') {
        return;
      }
      const awaits = [];
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
      if (!awaits.slice(1).some((a) => containsCall(a.argument))) {
        return;
      }
      context.report({
        node,
        messageId: 'booleanLogic',
        data: { count: String(awaits.length) },
      });
    }

    return {
      Program(node) {
        processBody(node.body);
      },
      BlockStatement(node) {
        if (
          ignoreTry &&
          node.parent &&
          (node.parent.type === 'TryStatement' || node.parent.type === 'CatchClause')
        ) {
          return;
        }
        processBody(node.body);
      },
      SwitchCase(node) {
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
};
