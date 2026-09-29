import type { Rule } from 'eslint';

// Stellar secret keys ("S..." strkeys): 56 chars, base32 alphabet.
const SECRET_KEY_PATTERN = /^S[A-Z2-7]{55}$/;

/**
 * Prevents accidental inclusion of hardcoded Stellar secret keys in source files or logs.
 * Secret keys must be kept in secure key stores/environment variables and sanitized in logs (issue #525).
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded or unredacted Stellar secret keys in source files and log output',
      recommended: true,
      url: 'https://github.com/SoroStream/sorostream-sdk/blob/main/packages/eslint-plugin/README.md#no-secret-key-exposure',
    },
    schema: [],
    messages: {
      exposedSecret:
        'Detected hardcoded or unredacted Stellar secret key. Use environment variables and wrap log outputs with redactSecretKey().',
    },
  },
  create(context) {
    return {
      Literal(node: Rule.Node) {
        if (
          node.type === 'Literal' &&
          typeof node.value === 'string' &&
          SECRET_KEY_PATTERN.test(node.value)
        ) {
          context.report({ node, messageId: 'exposedSecret' });
        }
      },
    };
  },
};

export default rule;
