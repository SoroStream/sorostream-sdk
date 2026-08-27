import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../src/rules/await-async-sdk-methods.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('await-async-sdk-methods', () => {
  it('passes RuleTester valid/invalid cases', () => {
    ruleTester.run('await-async-sdk-methods', rule, {
      valid: [
        `async function run(client, id) { await client.withdraw(id); }`,
        `async function run(client, id) { return client.withdraw(id); }`,
        `async function run(client, id) { const p = client.withdraw(id); await p; }`,
        // Not a known SDK method name — never flagged regardless of await.
        `function run(obj) { obj.doSomethingUnrelated(); }`,
        {
          code: `async function run(client, id) { await client.withdraw(id); }`,
          options: [{ methods: ['withdraw'] }],
        },
      ],
      invalid: [
        {
          code: `async function run(client, id) { client.withdraw(id); }`,
          errors: [{ messageId: 'missingAwait', data: { method: 'withdraw' } }],
        },
        {
          code: `async function run(client, id) { client.createStream({ id }); }`,
          errors: [{ messageId: 'missingAwait', data: { method: 'createStream' } }],
        },
        {
          // Custom `methods` option covers a project-specific method name.
          code: `function run(obj) { obj.customAsyncOp(); }`,
          options: [{ methods: ['customAsyncOp'] }],
          errors: [{ messageId: 'missingAwait', data: { method: 'customAsyncOp' } }],
        },
      ],
    });
  });
});
