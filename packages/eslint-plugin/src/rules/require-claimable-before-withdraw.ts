import type { Rule } from 'eslint';

// Deliberately returns a plain `boolean`, not a type predicate: this helper
// is called twice in sequence against the same `node` with different
// `methodName` values (see below), and a type predicate's false-branch
// narrowing from the first call would permanently exclude CallExpression
// from `node`'s type before the second call ever runs, making it resolve to
// `never`. The CallExpression shape needed by the fixer is asserted
// explicitly at its one call site instead.
function isMethodCall(node: Rule.Node, methodName: string): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === methodName
  );
}

/**
 * Warns when `withdraw` is called without a preceding `getClaimable` call in
 * the same function scope. Calling `withdraw` blind risks a wasteful
 * zero-amount transaction — checking `getClaimable` first lets the caller
 * skip the call entirely when nothing is claimable.
 *
 * @fixable The fixer inserts a `getClaimable` call before the `withdraw` call.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require calling `getClaimable` before `withdraw` to avoid a wasteful zero-amount transaction',
      recommended: true,
      url: 'https://github.com/SoroStream/sorostream-sdk/blob/main/packages/eslint-plugin/README.md#require-claimable-before-withdraw',
    },
    schema: [],
    messages: {
      missingCheck:
        'Call `getClaimable` before `withdraw` to avoid a wasteful zero-amount transaction.',
    },
    fixable: 'code',
  },
  create(context) {
    // One entry per enclosing function scope (module scope counts as the
    // outermost "function"). `true` once `getClaimable` has been seen.
    const scopeStack: boolean[] = [false];

    function enterScope() {
      scopeStack.push(false);
    }
    function exitScope() {
      scopeStack.pop();
    }

    return {
      FunctionDeclaration: enterScope,
      'FunctionDeclaration:exit': exitScope,
      FunctionExpression: enterScope,
      'FunctionExpression:exit': exitScope,
      ArrowFunctionExpression: enterScope,
      'ArrowFunctionExpression:exit': exitScope,
      CallExpression(node: Rule.Node) {
        if (isMethodCall(node, 'getClaimable')) {
          scopeStack[scopeStack.length - 1] = true;
          return;
        }
        if (isMethodCall(node, 'withdraw')) {
          // isMethodCall() returning true here guarantees node.type ===
          // 'CallExpression' at runtime; assert it explicitly since
          // isMethodCall is deliberately typed as returning a plain boolean
          // (see its definition above).
          const withdrawNode = node as Extract<Rule.Node, { type: 'CallExpression' }>;
          const checked = scopeStack[scopeStack.length - 1];
          if (!checked) {
            context.report({
              node: withdrawNode,
              messageId: 'missingCheck',
              fix(fixer) {
                // Get the source code
                const sourceCode = context.getSourceCode();

                // Extract arguments from the withdraw call
                const args = withdrawNode.arguments
                  .map((arg) => sourceCode.getText(arg))
                  .join(', ');

                // Create the getClaimable call with proper await
                const getClaimableCall = `await client.getClaimable(${args});`;

                // Try to get the parent statement to insert before it properly
                // The structure should be: ExpressionStatement -> AwaitExpression -> CallExpression (node)
                let parentStmt: Rule.Node | null = withdrawNode.parent;
                while (parentStmt && parentStmt.type !== 'ExpressionStatement') {
                  parentStmt = parentStmt.parent;
                }

                if (parentStmt) {
                  // Preserve the withdraw statement's indentation: insertTextBefore
                  // inserts after the leading whitespace already in the source, so
                  // the inserted line must re-supply that same indentation for the
                  // line that follows it.
                  const stmtStart = parentStmt.range![0];
                  const lineStart = sourceCode.text.lastIndexOf('\n', stmtStart - 1) + 1;
                  const indentation = sourceCode.text.slice(lineStart, stmtStart);
                  // Insert the getClaimable call as a separate statement before the withdraw statement
                  return fixer.insertTextBefore(parentStmt, `${getClaimableCall}\n${indentation}`);
                } else {
                  // Fallback: insert before the withdraw call expression (original approach)
                  return fixer.insertTextBefore(withdrawNode, `${getClaimableCall} `);
                }
              },
            });
          }
        }
      },
    };
  },
};

export default rule;
