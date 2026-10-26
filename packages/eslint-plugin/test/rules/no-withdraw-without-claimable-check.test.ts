import { describe, it, expect } from 'vitest';
import { Linter, RuleTester } from 'eslint';
import rule from '../../src/rules/no-withdraw-without-claimable-check.js';
import plugin, { rules } from '../../src/index.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('no-withdraw-without-claimable-check', () => {
  it('passes RuleTester valid/invalid cases and auto-fixes unguarded withdraw calls', () => {
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
          output: `async function run(client, id) {
            await client.getClaimable(id);
            await client.withdraw(id);
          }`,
        },
        {
          code: `async function run(client, id) {
            await client.cancelStream(id);
            await client.withdraw(id);
          }`,
          errors: [{ messageId: 'missingCheck' }],
          output: `async function run(client, id) {
            await client.cancelStream(id);
            await client.getClaimable(id);
            await client.withdraw(id);
          }`,
        },
        {
          code: `async function run(client, id) {
            async function check() {
              await client.getClaimable(id);
            }
            await client.withdraw(id);
          }`,
          errors: [{ messageId: 'missingCheck' }],
          output: `async function run(client, id) {
            async function check() {
              await client.getClaimable(id);
            }
            await client.getClaimable(id);
            await client.withdraw(id);
          }`,
        },
      ],
    });
  });

  it('produces only a single warning for a single unguarded withdraw under recommended config (issue #763)', () => {
    expect(rules).not.toHaveProperty('require-claimable-before-withdraw');
    expect(plugin.configs?.recommended).toBeDefined();

    const linter = new Linter({ configType: 'flat' });
    const flatRecommended = plugin.configs!['flat/recommended'] as Linter.Config;
    const messages = linter.verify(
      `async function run(client, id) {
        await client.withdraw(id);
      }`,
      [
        {
          languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
          ...flatRecommended,
        },
      ],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('@sorostream/no-withdraw-without-claimable-check');
    expect(messages[0].severity).toBe(1);
  });
});
