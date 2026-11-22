import { describe, it, expect } from 'vitest';
import type { Linter } from 'eslint';
import plugin from '../src/index.js';

describe('@sorostream/eslint-plugin configs (#763)', () => {
  it('does not enable both duplicate withdraw/claimable rules in recommended configs', () => {
    const legacyRecommended = plugin.configs?.recommended as Linter.LegacyConfig;
    const flatRecommended = plugin.configs?.['flat/recommended'] as Linter.Config;

    for (const config of [legacyRecommended, flatRecommended]) {
      const rules = config.rules ?? {};
      const hasLegacy = '@sorostream/no-withdraw-without-claimable-check' in rules;
      const hasFixable = '@sorostream/require-claimable-before-withdraw' in rules;

      expect(hasFixable).toBe(true);
      expect(hasLegacy).toBe(false);
    }
  });
});
