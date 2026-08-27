# Error Reference

All errors thrown by this SDK extend `SoroStreamError` (itself an `Error`). Each
error is exported from the package root, so callers can narrow on the
concrete class:

```ts
import { InsufficientAmountError, TransactionFailedError } from "sorostream-sdk";

try {
  await client.createStream(params);
} catch (err) {
  if (err instanceof InsufficientAmountError) {
    // fix params and retry
  } else if (err instanceof TransactionFailedError) {
    // inspect err.message for the on-chain rejection reason
  }
}
```

Errors fall into two layers:

- **SDK-layer** — thrown by client-side validation *before* any transaction
  is submitted (bad input, malformed address, etc). These are cheap to fix
  and retry immediately after correcting the input.
- **Contract-layer** — surfaced *after* a transaction was submitted and
  rejected by the on-chain contract. The SDK does not decode individual
  contract panic codes; it wraps the raw rejection in `TransactionFailedError`
  with the contract's error details in `message`.

## `SoroStreamError`

Base class for every error in this package. Thrown directly (rather than as
one of its subclasses) by a few low-level utilities — `calculateFlowRate` and
`batchSize` in `utils.ts` — for generic input validation that doesn't warrant
its own subclass.

- **Cause:** Generic validation failure with no dedicated subclass.
- **Typical trigger:** Calling `calculateFlowRate` with `durationSeconds <= 0`, or `batchSize(n)` with `n` outside `1..25`.
- **Recovery:** Read `error.message` and correct the offending argument.

## `InsufficientAmountError`

- **Cause:** A monetary or rate argument was zero or negative.
- **Typical trigger:** `createStream`/`topUp`/`operatorTopUp` called with `amount <= 0n`, or `updateFlowRate` called with `newFlowRate <= 0n`.
- **Recovery:** Validate amounts client-side before calling the SDK; ensure values are in stroops and positive.
- **Thrown by:** `createStream`, `topUp`, `operatorTopUp`, `updateFlowRate`, `estimateCreateStreamFee`, `estimateTopUpFee` (the latter two as a bare `Error` with the same message text).

## `ZeroDurationError`

- **Cause:** A stream's duration would resolve to `endTime <= startTime`, which the contract rejects as an immediate 100%-vested withdrawal.
- **Typical trigger:** `createStream` called with `durationSeconds` less than `MIN_STREAM_DURATION_SECONDS` (1s), or a computed `endTime` that doesn't exceed `startTime`.
- **Recovery:** Ensure `durationSeconds >= 1`; this is enforced in `validateStreamParams` before submission, so the fix is purely in the caller's input.
- **Thrown by:** `createStream` (via internal `validateStreamParams`).

## `InvalidAddressError`

- **Cause:** A supplied Stellar address failed `isValidStellarAddress` (wrong length/charset/prefix).
- **Typical trigger:** Typo'd or non-Stellar address passed as `recipient`, `token`, `recipientA`/`recipientB`, or `newRecipient`.
- **Recovery:** Validate addresses with `isValidStellarAddress` before calling the SDK, or surface the bad value (`error.message` includes it) back to the user for correction.
- **Thrown by:** `createStream`, `splitStream`, `transferStream`.

## `AccountNotFoundError`

- **Cause:** The recipient or sender account does not exist on the target Stellar network (e.g. never funded).
- **Typical trigger:** `createStream` against a `recipient` address with no on-chain account, or a sender wallet that hasn't been funded on the current network.
- **Recovery:** Fund the account (e.g. via Friendbot on testnet) before retrying, or confirm `client.getNetwork()` matches the network the account actually exists on.
- **Thrown by:** `createStream` (via internal `validateStreamParams`).

## `StreamNotFoundError`

- **Cause:** No stream exists for the given ID on the current network.
- **Typical trigger:** `getStream`/`exportStream` called with a stale or wrong `streamId`; or `createStream`'s post-submission fetch couldn't locate the newly created stream.
- **Recovery:** Double-check the stream ID and that `client.getNetwork()` matches the network the stream was created on. If thrown from `createStream` itself, treat it as the transaction having succeeded but the ID lookup having raced — re-fetch via `getStreamsBySender`.
- **Thrown by:** `getStream`, `exportStream`, `createStream`.

## `TransactionFailedError`

- **Cause:** A submitted transaction was rejected by the network or failed on-chain (contract-layer rejection, or `sendTransaction` returning `status: "ERROR"`).
- **Typical trigger:** Calling a mutating method (`cancelStream`, `withdraw`, `pause`, etc.) on a stream in a state the contract doesn't allow (e.g. cancelling an already-cancelled stream), insufficient trustline balance, or a transient network rejection.
- **Recovery:** Inspect `error.message` for the contract's rejection details or the transaction hash; for transient network errors, retry; for state-conflict errors, re-fetch the stream with `getStream` to check its current status before retrying.
- **Thrown by:** Every mutating method — `createStream`, `createStreams`, `withdraw`, `batchWithdraw`, `cancelStream`, `topUp`, `batchCancel`, `updateFlowRate`, `setOperator`, `operatorCancelStream`, `operatorTopUp`, `splitStream`, `transferStream`, `pause`, `resume`, `executeBatch`, and (per-slot) `bulkCreateStreams`.

## `BulkCreatePartialError`

- **Cause:** One or more rows in a `bulkCreateStreams` call failed validation or transaction submission while others succeeded.
- **Typical trigger:** A mixed-token batch where one row's recipient/token is invalid, or one chunk's transaction is rejected by the network while other chunks commit fine.
- **Recovery:** Inspect `error.successfulBatches` for streams that were created, and `error.failedSlots` (each `{ index, row, error }`) for what to retry. Re-submit only the failed rows via a fresh `bulkCreateStreams` call (or `createStream` individually) rather than the whole batch.
- **Thrown by:** `bulkCreateStreams`.

## `StreamNotActiveError`

Reserved for contract-layer state checks (e.g. operating on a paused or
cancelled stream). The SDK does not currently decode this from the contract's
raw rejection — such failures presently surface as `TransactionFailedError`
with the panic detail in `message`. The typed class is exported so callers
who parse `error.message` themselves can construct/compare against it
consistently, and so a future SDK release can throw it directly once contract
error codes are decoded.

- **Cause:** An operation requires the stream to be in `Active` status, but it is `Paused`/`Cancelled`/`Completed`.
- **Typical trigger:** Calling `withdraw`, `cancelStream`, `pause`, etc. on a stream that isn't active.
- **Recovery:** Call `getStream` first and check `stream.status` before mutating.

## `InsufficientBalanceError`

Reserved for contract-layer balance/trustline checks, in the same position as
`StreamNotActiveError` above — currently surfaces as `TransactionFailedError`
rather than being thrown directly by this SDK.

- **Cause:** The sender lacks sufficient token balance or a trustline for the stream's token.
- **Typical trigger:** `createStream`/`topUp` with an `amount` exceeding the sender's available balance, or no trustline established for a non-native asset.
- **Recovery:** Verify balance and trustline (e.g. via Horizon/RPC account query) before submitting; establish a trustline if missing.
