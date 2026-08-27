---
"@sorostream/sdk": patch
---

Fix `getClaimable` returning `undefined`/throwing at runtime: a prior merge had dropped the TTL-cache population, in-flight request de-duplication, and negative-value clamping around the RPC call. `getClaimable` now correctly caches results for 5s, de-duplicates concurrent calls for the same stream ID, and clamps negative on-chain values to `0n` as originally intended. Also fixes `formatUSDC`'s locale-aware formatting to default `minimumFractionDigits` to 2, and removes duplicated content in `src/utils.ts` and `src/types.ts` left over from an earlier merge conflict.
