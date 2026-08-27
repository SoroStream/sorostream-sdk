import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../src/rules/no-hardcoded-contract-id.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const VALID_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

describe('no-hardcoded-contract-id', () => {
  it('passes RuleTester valid/invalid cases', () => {
    ruleTester.run('no-hardcoded-contract-id', rule, {
      valid: [
        `const contractId = process.env.CONTRACT_ID;`,
        `const client = new SoroStreamClient({ contractId: process.env.CONTRACT_ID });`,
        // Not a valid contract ID shape (wrong length / prefix) — ignored.
        `const notAContractId = "hello world";`,
        `const alsoNot = "C123";`,
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
