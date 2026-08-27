import type { ESLint, Linter } from 'eslint';
import noWithdrawWithoutClaimableCheck from './rules/no-withdraw-without-claimable-check.js';
import awaitAsyncSdkMethods from './rules/await-async-sdk-methods.js';
import noHardcodedContractId from './rules/no-hardcoded-contract-id.js';

const PLUGIN_NAME = '@sorostream';

const rules = {
  'no-withdraw-without-claimable-check': noWithdrawWithoutClaimableCheck,
  'await-async-sdk-methods': awaitAsyncSdkMethods,
  'no-hardcoded-contract-id': noHardcodedContractId,
};

const recommendedRules: Linter.RulesRecord = {
  '@sorostream/no-withdraw-without-claimable-check': 'warn',
  '@sorostream/await-async-sdk-methods': 'warn',
  '@sorostream/no-hardcoded-contract-id': 'warn',
};

const plugin: ESLint.Plugin = {
  meta: {
    name: PLUGIN_NAME,
    version: '0.1.0',
  },
  rules,
};

// ESLint v8 eslintrc-style config (`extends: ["plugin:@sorostream/recommended"]`).
const recommended: Linter.LegacyConfig = {
  plugins: ['@sorostream'],
  rules: recommendedRules,
};

// ESLint v9 flat config (`extends: [sorostream.configs["flat/recommended"]]`).
const flatRecommended: Linter.Config = {
  plugins: { '@sorostream': plugin },
  rules: recommendedRules,
};

plugin.configs = {
  recommended,
  'flat/recommended': flatRecommended,
};

export default plugin;
export { rules };
