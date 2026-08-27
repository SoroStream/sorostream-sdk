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
            context.report({ node, messageId: 'missingCheck' });
          }
        }
      },
    };
  },
};

export default rule;
