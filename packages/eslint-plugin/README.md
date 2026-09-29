# @sorostream/eslint-plugin

ESLint rules that catch common `@sorostream/sdk` misuse at development time. Works with ESLint v8 (eslintrc) and v9 (flat config).

## Installation

```bash
npm install --save-dev @sorostream/eslint-plugin eslint
```

## Usage

### ESLint v9 (flat config)

```js
// eslint.config.js
import sorostream from "@sorostream/eslint-plugin";

export default [
  sorostream.configs["flat/recommended"],
];
```

### ESLint v8 (eslintrc)

```json
{
  "plugins": ["@sorostream"],
  "extends": ["plugin:@sorostream/recommended"]
}
```

Both forms enable all four rules below as warnings. To configure rules individually:

```js
// eslint.config.js
import sorostream from "@sorostream/eslint-plugin";

export default [
  {
    plugins: { "@sorostream": sorostream },
    rules: {
      "@sorostream/no-withdraw-without-claimable-check": "error",
      "@sorostream/await-async-sdk-methods": "error",
      "@sorostream/no-hardcoded-contract-id": "warn",
    },
  },
];
```

## Rules

### `no-withdraw-without-claimable-check`

Warns when `withdraw` is called without a preceding `getClaimable` call in the same function scope. Calling `withdraw` blind risks a wasteful zero-amount transaction.

```js
// ❌ Incorrect
async function claim(client, streamId) {
  await client.withdraw(streamId);
}

// ✅ Correct
async function claim(client, streamId) {
  const claimable = await client.getClaimable(streamId);
  if (claimable > 0n) {
    await client.withdraw(streamId);
  }
}
```

### `await-async-sdk-methods`

Warns when a known SDK async method (`createStream`, `withdraw`, `getStream`, `getClaimable`, `batchWithdraw`, etc.) is called as a bare statement without `await` — an unhandled rejection risk.

```js
// ❌ Incorrect
client.withdraw(streamId);

// ✅ Correct
await client.withdraw(streamId);
```

Configure a custom method list (replaces the default):

```js
{
  "@sorostream/await-async-sdk-methods": ["warn", { "methods": ["withdraw", "createStream"] }]
}
```

### `no-hardcoded-contract-id`

Warns when a string literal matches the shape of a Stellar/Soroban contract ID (`C` + 55 base32 characters), since contract IDs differ per network/deployment and should come from configuration.

```js
// ❌ Incorrect
const client = new SoroStreamClient({
  contractId: "CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T",
});

// ✅ Correct
const client = new SoroStreamClient({
  contractId: process.env.SOROSTREAM_CONTRACT_ID,
});
```

### `no-magic-flow-rate`

Warns when numeric literals are used for flowRate values instead of using the SDK's `toStroops()` or `ratePerSecond()` utilities. Hardcoded numeric flow rates are unreadable and error-prone.

```js
// ❌ Incorrect
await client.updateFlowRate({ streamId: "123", newFlowRate: 1000000 });

// ❌ Incorrect
const params = { streamId: "123", flowRate: 1000000 };
await client.updateFlowRate(params);

// ✅ Correct
await client.updateFlowRate({ 
  streamId: "123", 
  newFlowRate: toStroops("100") 
});

// ✅ Correct
await client.updateFlowRate({ 
  streamId: "123", 
  newFlowRate: ratePerSecond(toStroops("10"), "day") 
});

// ✅ Correct (using a variable)
const rate = calculateFlowRate(toStroops("100"), 3600);
await client.updateFlowRate({ streamId: "123", newFlowRate: rate });
```
