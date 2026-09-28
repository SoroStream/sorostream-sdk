# SoroStream SDK — Troubleshooting Guide

This guide details common errors, root causes, diagnostic steps, and recommended fixes when integrating `@sorostream/sdk`.

---

## 1. Account & Balance Errors

### `AccountNotFoundError`

* **Symptom**: `AccountNotFoundError: Account G... does not exist on Stellar network.`
* **Root Cause**: The sender or recipient Stellar address has not been created on-chain with the minimum XLM reserve (1 XLM on mainnet / testnet).
* **Fix**:
  * **Testnet**: Fund the account using Stellar Friendbot (`https://friendbot.stellar.org?addr=YOUR_ADDRESS`).
  * **Mainnet**: Send at least 1 XLM to the account address before initiating stream creation.

### `InsufficientAmountError`

* **Symptom**: `InsufficientAmountError: Amount must be strictly greater than 0.`
* **Root Cause**: Passed `0n` or negative value for `amount` in `createStream` or `topUp`.
* **Fix**: Use `toStroops('10.00')` to convert decimal strings to valid positive `bigint` base units.

---

## 2. Stream Validation & Idempotency Errors

### `SelfStreamError`

* **Symptom**: `SelfStreamError: Sender and recipient addresses cannot be identical.`
* **Root Cause**: `params.recipient` matches the connected wallet sender address.
* **Fix**: Ensure the recipient address is distinct from the sender address.

### `DuplicateStreamError`

* **Symptom**: `DuplicateStreamError: An active stream already exists for this recipient and token.`
* **Root Cause**: Duplicate creation check detected an existing `Active` stream between the same sender, recipient, and token contract.
* **Fix**:
  * Top up the existing stream using `client.topUp({ streamId, amount })` instead of creating a new stream.
  * Or disable duplicate checks by setting `checkDuplicate: false` in `SoroStreamClientConfig` if multiple concurrent streams are intended.

---

## 3. Network & Circuit Breaker Errors

### `CircuitBreakerOpenError`

* **Symptom**: `CircuitBreakerOpenError: Circuit breaker is OPEN for RPC host soroban-testnet.stellar.org`
* **Root Cause**: Consecutive RPC request failures or timeouts exceeded the failure threshold, triggering automatic RPC isolation.
* **Fix**:
  * Provide multiple RPC fallback URLs in `rpcUrl`: `['https://soroban-testnet.stellar.org', 'https://rpc-fallback.example.com']`.
  * Check network connectivity or status at `https://dashboard.stellar.org`.
  * Reset circuit breaker manually if needed: `client.resetCircuitBreaker()`.

---

## 4. Wallet Signing & Hardware Errors

### Freighter Popup Blocked or Rejected

* **Symptom**: `UserDeclinedError: User rejected transaction in Freighter.`
* **Root Cause**: User dismissed the Freighter extension modal or popups are blocked in the browser.
* **Fix**: Wrap transaction calls in user click event handlers to ensure browser popup permissions are granted.

### Ledger Transport Timeout

* **Symptom**: `LedgerError: Transport status 0x6804 or device locked.`
* **Root Cause**: Ledger device is locked, app is closed, or USB/WebHID permission was denied.
* **Fix**: Ensure Stellar App is open on Ledger device and blind signing is enabled in device settings.
