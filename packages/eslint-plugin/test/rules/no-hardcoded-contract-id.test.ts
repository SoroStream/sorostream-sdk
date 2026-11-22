import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../src/rules/no-hardcoded-contract-id.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const VALID_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOO_SHORT = `C${'A'.repeat(54)}`;
const TOO_LONG = `C${'A'.repeat(56)}`;

describe('no-hardcoded-contract-id', () => {
  it('passes RuleTester valid/invalid cases', () => {
    ruleTester.run('no-hardcoded-contract-id', rule, {
      valid: [
        `const contractId = process.env.CONTRACT_ID;`,
        `const client = new SoroStreamClient({ contractId: process.env.CONTRACT_ID });`,
        // Not a valid contract ID shape (wrong length / prefix) — ignored.
        `const notAContractId = "hello world";`,
        `const alsoNot = "C123";`,
        {
          name: 'contract-ID-shaped string with an invalid length is ignored',
          code: `const id = "${TOO_SHORT}";`,
        },
        {
          name: 'contract-ID-shaped string that is too long is ignored',
          code: `const id = "${TOO_LONG}";`,
        },
        {
          name: 'ordinary C-prefixed CSS class name is ignored',
          code: 'const className = "CtaButton";',
        },
        // A Stellar *account* address (G-prefix) is not a contract ID.
        `const account = "GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF";`,
      ],
      invalid: [
        {
          code: `const contractId = "${VALID_CONTRACT_ID}";`,
          errors: [{ messageId: 'hardcoded', data: { value: VALID_CONTRACT_ID } }],
        },
        {
          code: `const client = new SoroStreamClient({ contractId: "${VALID_CONTRACT_ID}" });`,
          errors: [{ messageId: 'hardcoded', data: { value: VALID_CONTRACT_ID } }],
        },
      ],
    });
  });
});
