import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../src/rules/no-withdraw-without-claimable-check.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('no-withdraw-without-claimable-check', () => {
  it('passes RuleTester valid/invalid cases', () => {
    ruleTester.run('no-withdraw-without-claimable-check', rule, {
      valid: [
        `async function run(client, id) {
          const claimable = await client.getClaimable(id);
          if (claimable > 0n) await client.withdraw(id);
        }`,
        `async function run(client, id) {
          await client.getClaimable(id);
          await client.withdraw(id);
        }`,
        `const run = async (client, id) => {
          await client.getClaimable(id);
          return client.withdraw(id);
        };`,
        // withdraw with no claimable check anywhere is fine at module scope
        // as long as this specific rule only cares about *some* call to
        // getClaimable existing in the same scope — an unrelated method call
        // must not trip it.
        `async function run(client, id) {
          await client.getClaimable(id);
          await client.cancelStream(id);
        }`,
      ],
      invalid: [
        {
          code: `async function run(client, id) {
            await client.withdraw(id);
          }`,
          errors: [{ messageId: 'missingCheck' }],
        },
        {
          code: `async function run(client, id) {
            await client.cancelStream(id);
            await client.withdraw(id);
          }`,
          errors: [{ messageId: 'missingCheck' }],
        },
        {
          // getClaimable is only checked inside a *different* function scope
          // (a callback), so the withdraw call at the outer scope is still
          // unguarded.
          code: `async function run(client, id) {
            async function check() {
              await client.getClaimable(id);
            }
            await client.withdraw(id);
          }`,
          errors: [{ messageId: 'missingCheck' }],
        },
      ],
    });
  });
});
