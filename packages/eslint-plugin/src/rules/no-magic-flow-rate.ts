import type { Rule } from 'eslint';

/**
 * Check if a node represents a numeric literal
 */
function isNumericLiteral(node: Rule.Node): boolean {
  return node.type === 'Literal' && typeof node.value === 'number' && !Number.isNaN(node.value);
}

/**
 * Check if a node represents a call to toStroops or ratePerSecond
 */
function isFlowRateUtilCall(node: Rule.Node): boolean {
  if (node.type !== 'CallExpression') return false;
  
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' && callee.type !== 'Identifier') return false;
  
  let functionName: string | null = null;
  
  if (callee.type === 'Identifier') {
    functionName = callee.name;
  } else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    functionName = callee.property.name;
  }
  
  return functionName === 'toStroops' || functionName === 'ratePerSecond';
}

/**
 * Warns when numeric literals are used for flowRate values instead of using
 * the SDK's toStroops() or ratePerSecond() utilities.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require using toStroops() or ratePerSecond() for flowRate values instead of numeric literals',
      recommended: false,
      url: 'https://github.com/SoroStream/sorostream-sdk/blob/main/packages/eslint-plugin/README.md#no-magic-flow-rate',
    },
    schema: [],
    messages: {
      magicFlowRate:
        'Do not use numeric literals for flowRate. Use toStroops(amount) or ratePerSecond(amount, period) instead.',
    },
  },
  create(context) {
    return {
      // Check for flowRate property in object literals and updateFlowRate calls
      Property(node: Rule.Node) {
        // Handle object properties like: flowRate: 1000000
        if (
          node.key &&
          node.key.type === 'Identifier' &&
          node.key.name === 'flowRate' &&
          node.value
        ) {
          if (isNumericLiteral(node.value)) {
            context.report({ node: node.value, messageId: 'magicFlowRate' });
          }
        }
      },
      
      // Check for updateFlowRate calls with numeric literals
      CallExpression(node: Rule.Node) {
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'updateFlowRate' &&
          node.arguments.length === 1
        ) {
          const arg = node.arguments[0];
          if (arg.type === 'ObjectExpression') {
            // Look for flowRate property in the argument object
            for const prop of arg.properties) {
              if (
                prop.type === 'Property' &&
                prop.key &&
                prop.key.type === 'Identifier' &&
                prop.key.name === 'flowRate' &&
                prop.value
              ) {
                if (isNumericLiteral(prop.value)) {
                  context.report({ node: prop.value, messageId: 'magicFlowRate' });
                }
              }
            }
          }
        }
      },
    };
  },
};

export default rule;