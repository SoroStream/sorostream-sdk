import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../src/rules/no-secret-key-exposure.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const VALID_SECRET_KEY = `S${'A'.repeat(55)}`;
const INVALID_BASE32_LOWERCASE = `S${'a'.repeat(55)}`;
const INVALID_BASE32_DIGITS = `S${'0189'.repeat(13)}018`;
const TOO_SHORT = `S${'A'.repeat(54)}`;
const TOO_LONG = `S${'A'.repeat(56)}`;

describe('no-secret-key-exposure', () => {
  it('passes RuleTester valid/invalid cases', () => {
    ruleTester.run('no-secret-key-exposure', rule, {
      valid: [
        `const key = "${INVALID_BASE32_LOWERCASE}";`,
        `const key = "${INVALID_BASE32_DIGITS}";`,
        `const key = "${TOO_SHORT}";`,
        `const key = "${TOO_LONG}";`,
        'const key = process.env.STELLAR_SECRET;',
        {
          name: 'template literals are not inspected by the Literal-only visitor',
          code: `const key = \`${VALID_SECRET_KEY}\`;`,
        },
        {
          name: 'template literal expressions are not inspected by the Literal-only visitor',
          code: 'const key = `${process.env.STELLAR_SECRET}`;',
        },
      ],
      invalid: [
        {
          code: `const key = "${VALID_SECRET_KEY}";`,
          errors: [{ messageId: 'exposedSecret' }],
        },
        {
          code: `console.log("${VALID_SECRET_KEY}");`,
          errors: [{ messageId: 'exposedSecret' }],
        },
      ],
    });
  });
});
