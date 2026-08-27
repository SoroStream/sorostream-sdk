import type { Rule } from 'eslint';

// Stellar/Soroban contract addresses ("C..." strkeys): 56 chars, base32 alphabet.
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * Warns when a string literal looks like a hardcoded Stellar contract ID.
 * Contract IDs differ per network/deployment and should be loaded from
 * configuration (typically an environment variable) rather than baked into
 * source.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded Stellar contract IDs; load them from environment/config instead',
      recommended: true,
      url: 'https://github.com/SoroStream/sorostream-sdk/blob/main/packages/eslint-plugin/README.md#no-hardcoded-contract-id',
    },
    schema: [],
    messages: {
      hardcoded:
        "Contract ID '{{value}}' looks hardcoded. Load it from an environment variable or config instead of baking it into source.",
    },
  },
  create(context) {
    return {
      Literal(node: Rule.Node) {
        if (
          node.type === 'Literal' &&
          typeof node.value === 'string' &&
          CONTRACT_ID_PATTERN.test(node.value)
        ) {
          context.report({ node, messageId: 'hardcoded', data: { value: node.value } });
        }
      },
    };
  },
};

export default rule;
