import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../src/rules/no-magic-flow-rate.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

describe('no-magic-flow-rate', () => {
  it('passes RuleTester valid/invalid cases', () => {
    ruleTester.run('no-magic-flow-rate', rule, {
      valid: [
        // Using toStroops
        `async function run(client) {
          await client.updateFlowRate({ streamId: "123", newFlowRate: toStroops("100") });
        }`,
        
        // Using ratePerSecond
        `async function run(client) {
          await client.updateFlowRate({ streamId: "123", newFlowRate: ratePerSecond(toStroops("10"), "day") });
        }`,
        
        // Using a variable (not a literal)
        `async function run(client) {
          const rate = calculateFlowRate(toStroops("100"), 3600);
          await client.updateFlowRate({ streamId: "123", newFlowRate: rate });
        }`,
        
        // flowRate in other contexts (not updateFlowRate or object creation)
        `async function run(client) {
          const stream = await client.getStream("123");
          console.log(stream.flowRate);
        }`,
        
        // Other properties besides flowRate
        `async function run(client) {
          await client.updateFlowRate({ streamId: "123", newFlowRate: 1000000, otherProp: 5 });
        }`,
      ],
      invalid: [
        {
          // Numeric literal in updateFlowRate
          code: `async function run(client) {
            await client.updateFlowRate({ streamId: "123", newFlowRate: 1000000 });
          }`,
          errors: [{ messageId: 'magicFlowRate' }],
        },
        {
          // Numeric literal in object literal (flowRate property)
          code: `async function run(client) {
            const params = { streamId: "123", flowRate: 1000000 };
            await client.updateFlowRate(params);
          }`,
          errors: [{ messageId: 'magicFlowRate' }],
        },
        {
          // Numeric literal in nested object
          code: `async function run(client) {
            await client.updateFlowRate({ 
              streamId: "123", 
              flowRate: 1000000 
            });
          }`,
          errors: [{ messageId: 'magicFlowRate' }],
        },
        {
          // Zero literal
          code: `async function run(client) {
            await client.updateFlowRate({ streamId: "123", newFlowRate: 0 });
          }`,
          errors: [{ messageId: 'magicFlowRate' }],
        },
        {
          // Negative literal
          code: `async function run(client) {
            await client.updateFlowRate({ streamId: "123", newFlowRate: -500 });
          }`,
          errors: [{ messageId: 'magicFlowRate' }],
        },
        {
          // Decimal literal
          code: `async function run(client) {
            await client.updateFlowRate({ streamId: "123", newFlowRate: 100.5 });
          }`,
          errors: [{ messageId: 'magicFlowRate' }],
        },
      ],
    });
  });
});