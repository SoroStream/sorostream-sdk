# Migration Guide: v0.0.x to v0.1.0

This guide assists users upgrading from version 0.0.x to 0.1.0 of the @sorostream/sdk package. Version 0.1.0 contains breaking changes that may require updates to your code.

## Quick Upgrade Checklist

- [ ] Update `batchWithdraw` return value handling (see #229)
- [ ] Verify `getStreamsBySender` and `getStreamsByRecipient` caching behavior (see #230)
- [ ] Review any custom error handling for the above changes
- [ ] Re-run tests to catch any runtime issues

## Breaking Changes

### #229: batchWithdraw Return Type Change

**Summary:** The `batchWithdraw` method no longer throws an error when individual withdrawals fail. Instead, it returns a partial result separating successful and failed withdrawals.

**Before (v0.0.x):**
```ts
try {
  const results = await client.batchWithdraw([
    { streamId: "1", amount: toStroops("10") },
    { streamId: "2", amount: toStroops("20") },
    { streamId: "3", amount: toStroops("30") }
  ]);
  // If any withdrawal failed, the entire promise would reject
  // You would need to catch the error here
} catch (error) {
  // Handle error - you wouldn't know which specific streams failed
}
```

**After (v0.1.0):**
```ts
import { BatchWithdrawPartialResult } from '@sorostream/sdk';

const result: BatchWithdrawPartialResult = await client.batchWithdraw([
  { streamId: "1", amount: toStroops("10") },
  { streamId: "2", amount: toStroops("20") },
  { streamId: "3", amount: toStroops("30") }
]);

// Check for successful withdrawals
if (result.successes.length > 0) {
  console.log(`Successfully withdrawn from streams: ${result.successes.join(', ')}`);
}

// Check for failed withdrawals
if (result.failures.length > 0) {
  console.log(`Failed withdrawals:`);
  for (const failure of result.failures) {
    console.log(`  Stream ${failure.id}: ${failure.error.message}`);
  }
}

// No try/catch needed unless you want to handle unexpected errors
```

**What changed:**
- Return type changed from `Promise<BatchWithdrawResult[]>` to `Promise<BatchWithdrawPartialResult>`
- No longer throws on partial failures
- Always resolves with an object containing `successes` and `failures` arrays

### #230: getStreamsBySender/getStreamsByRecipient Caching Key Change

**Summary:** The caching mechanism for `getStreamsBySender` and `getStreamsByRecipient` was updated to include the network in the cache key, preventing cross-network cache contamination.

**Impact:** 
- Improved correctness when switching between networks (e.g., testnet ↔ mainnet)
- May affect cache hit rates if frequently switching networks
- No API changes required - pure internal implementation improvement

**Before:** Cache key was based only on address (`${address}`)
**After:** Cache key is now `${network}:${address}`

**Migration notes:** No code changes required. The SDK handles this internally. You may notice different cache performance characteristics when frequently switching networks.

## Additional Changes

While not breaking changes, the following notable additions may affect your implementation:

### New Features Added

- **`getMultipleStreamBalances`** (#445): Efficiently fetch claimable balances for multiple streams
- **`writeRateLimit`** (#464): Optional client-side rate limiting for write operations
- **Enhanced error handling**: More specific error types exported (`NonceNotSupportedError`, `BatchWithdrawPartialResult`, etc.)
- **Security improvements**: Non-TLS RPC URLs now rejected by default
- **Source maps**: Now published alongside distributed files for better debugging

### Dependency Updates

- Updated `@stellar/stellar-sdk` to ^13.3.0
- Updated `tsup` to ^8.0.0
- Updated `vitest` to ^2.0.0

## Getting Help

If you encounter issues during migration:

1. Review the full [CHANGELOG.md](CHANGELOG.md) for detailed change history
2. Check the API documentation via `npx typedoc` or visit the docs site
3. Open an issue on the [GitHub repository](https://github.com/SoroStream/sorostream-sdk/issues)
4. Check existing tests in the `test/` directory for usage examples

## Version Compatibility

- **v0.1.0** is not backward compatible with v0.0.x due to the breaking changes listed above
- All v0.0.x code will need to be updated to address the breaking changes
- Semantic versioning follows the MAJOR.MINOR.PATCH format where breaking changes increment the MAJOR version