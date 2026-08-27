---
"@sorostream/sdk": minor
---

Add `createFeeRetryMiddleware` plugin for automatic fee-bump retry on Soroban fee errors (#404).

- `createFeeRetryMiddleware(options?)` returns a `SoroStreamPlugin` that intercepts fee-insufficient RPC rejections and re-signals the caller to resubmit with a bumped fee.
- Configurable `bumpFactor` (default 1.5×), `maxFeeStroops` cap (default 100 000), `maxAttempts` limit (default 3), and `onRetry` callback.
- Emits `FeeRetryError` on each bumped retry attempt, carrying `suggestedFeeStroops`, `attempt` number, and the underlying `cause`.
- Detects fee errors from `result_code`, `code`, message text, nested `extras.result_codes`, and raw RPC response bodies for maximum compatibility.
