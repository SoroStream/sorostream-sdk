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
        {
          name: 'awaited withdraw call produces no reports',
          code: `async function run(client, id) { await client.withdraw(id); }`,
        },
        {
          name: 'returned withdraw call produces no reports',
          code: `async function run(client, id) { return client.withdraw(id); }`,
        },
        {
          name: 'assigned withdraw call produces no reports',
          code: `async function run(client, id) { const result = client.withdraw(id); return result; }`,
        },
        {
          name: 'assigned then awaited withdraw call produces no reports',
          code: `async function run(client, id) { const p = client.withdraw(id); await p; }`,
        },
        {
          name: 'custom methods option replaces the default method list',
          code: `async function run(client, id) { client.withdraw(id); }`,
          options: [{ methods: ['customAsyncOp'] }],
        },
        {
          name: 'not a known SDK method name produces no reports',
          code: `function run(obj) { obj.doSomethingUnrelated(); }`,
        },
        `async function run(client, params) { const res = await client.createStream(params); return res; }`,
        `const cancel = async (client, id) => { await client.cancelStream(id); };`,
      ],
      invalid: [
        {
          name: 'floating withdraw call produces exactly one report',
          code: `async function run(client, id) { client.withdraw(id); }`,
          errors: [{ messageId: 'missingAwait', data: { method: 'withdraw' } }],
        },
        {
          name: 'floating createStream call produces exactly one report',
          code: `async function run(client, id) { client.createStream({ id }); }`,
          errors: [{ messageId: 'missingAwait', data: { method: 'createStream' } }],
        },
        {
          name: 'floating cancelStream call in an arrow function produces exactly one report',
          code: `const cancel = (client, id) => { client.cancelStream(id); };`,
          errors: [{ messageId: 'missingAwait', data: { method: 'cancelStream' } }],
        },
        {
          name: 'custom methods option flags only the custom floating call',
          code: `function run(obj) { obj.customAsyncOp(); }`,
          options: [{ methods: ['customAsyncOp'] }],
          errors: [{ messageId: 'missingAwait', data: { method: 'customAsyncOp' } }],
        },
      ],
    });
  });
});
