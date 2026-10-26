import type { Rule } from 'eslint';

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
        'Disallow calling `withdraw` without a preceding `getClaimable` check in the same scope',
      recommended: true,
      url: 'https://github.com/SoroStream/sorostream-sdk/blob/main/packages/eslint-plugin/README.md#no-withdraw-without-claimable-check',
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
          const checked = scopeStack[scopeStack.length - 1];
          if (!checked) {
            context.report({
              node,
              messageId: 'missingCheck',
              fix(fixer) {
                const sourceCode = context.getSourceCode();
                const args = node.arguments.map((arg) => sourceCode.getText(arg)).join(', ');
                const getClaimableCall = `await client.getClaimable(${args});`;

                let parentStmt = node.parent;
                while (parentStmt && parentStmt.type !== 'ExpressionStatement') {
                  parentStmt = parentStmt.parent;
                }

                if (parentStmt) {
                  const stmtStart = parentStmt.range![0];
                  const lineStart = sourceCode.text.lastIndexOf('\n', stmtStart - 1) + 1;
                  const indentation = sourceCode.text.slice(lineStart, stmtStart);
                  return fixer.insertTextBefore(parentStmt, `${getClaimableCall}\n${indentation}`);
                } else {
                  return fixer.insertTextBefore(node, `${getClaimableCall} `);
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
