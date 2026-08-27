import type { Rule } from 'eslint';

/** SDK methods that return a Promise. Overridable via the `methods` option. */
const DEFAULT_ASYNC_METHODS = [
  'createStream',
  'withdraw',
  'cancelStream',
  'topUp',
  'getStream',
  'getClaimable',
  'getMultipleStreamBalances',
  'getStreamsBySender',
  'getStreamsByRecipient',
  'batchWithdraw',
  'batchCancel',
  'bulkCreateStreams',
  'transferStream',
  'pauseStream',
  'resumeStream',
  'setOperator',
  'operatorTopUp',
  'splitStream',
  'cloneStream',
  'updateFlowRate',
];

/**
 * Warns when a known SDK async method is called without `await` (or without
 * being returned/otherwise consumed), since the resulting promise's
 * rejection would otherwise go unhandled.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require `await` when calling SDK async methods',
      recommended: true,
      url: 'https://github.com/SoroStream/sorostream-sdk/blob/main/packages/eslint-plugin/README.md#await-async-sdk-methods',
    },
    schema: [
      {
        type: 'object',
        properties: {
          methods: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingAwait:
        "'{{method}}' returns a Promise — use `await` (or handle the returned promise) so rejections aren't silently ignored.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { methods?: string[] };
    const methods = new Set(options.methods ?? DEFAULT_ASYNC_METHODS);

    return {
      CallExpression(node: Rule.Node) {
        if (
          node.type !== 'CallExpression' ||
          node.callee.type !== 'MemberExpression' ||
          node.callee.computed ||
          node.callee.property.type !== 'Identifier' ||
          !methods.has(node.callee.property.name)
        ) {
          return;
        }

        // Flag only "floating" calls used as a bare statement — awaited
        // calls have an AwaitExpression parent, not ExpressionStatement,
        // and returned/assigned calls are consumed by the caller.
        const parent = node.parent;
        if (parent && parent.type === 'ExpressionStatement') {
          context.report({
            node,
            messageId: 'missingAwait',
            data: { method: node.callee.property.name },
          });
        }
      },
    };
  },
};

export default rule;
