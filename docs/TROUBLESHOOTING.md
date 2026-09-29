# SoroStream SDK — Troubleshooting Guide

This guide covers common errors encountered when using `@sorostream/sdk`, their underlying root causes, and recommended solutions.

---

## 1. `InsecureRpcUrlError`

### Symptom
```
InsecureRpcUrlError: RPC endpoint URL must use HTTPS protocol (received http://rpc.example.com).
```

### Cause
The SDK enforces secure TLS (`https://`) RPC endpoints in production environments to protect private transaction data from eavesdropping.

### Solution
Use an `https://` endpoint URL (e.g. `https://soroban-testnet.stellar.org`). For local testing with Soroban Quickstart, loopback addresses (`http://localhost:8000` or `http://127.0.0.1:8000`) are permitted.

---

## 2. `StartTimeInPastError`

### Symptom
```
StartTimeInPastError: Stream startTime cannot be set in the past.
```

### Cause
`startTime` was specified with a timestamp earlier than the current ledger time.

### Solution
Omit `startTime` to default to current ledger time, or pass `Math.floor(Date.now() / 1000)`:
```ts
const startTime = Math.floor(Date.now() / 1000) + 60; // start 1 min in future
```

---

## 3. `NonceNotSupportedError`

### Symptom
```
NonceNotSupportedError: Deployed contract version does not support caller-supplied nonces.
```

### Cause
The client passed a `nonce` parameter for stream idempotency, but the deployed Soroban contract version on-chain does not expose `get_version` or nonce support.

### Solution
Check capability prior to submission with `client.supportsNonce()`:
```ts
if (await client.supportsNonce()) {
  await client.createStream({ ...params, nonce: 'my-unique-key' });
} else {
  await client.createStream(params);
}
```

---

## 4. `WalletConnectSessionExpiredError` & Wallet Lock Errors

### Symptom
```
WalletConnectSessionExpiredError: The active WalletConnect session has expired or been terminated by the user.
```

### Cause
The user locked their wallet or the session topic expired mid-session.

### Solution
Wallet adapters expose `onConnectionChange()` listeners. Re-trigger the connection handshake:
```ts
const adapter = await createFreighterAdapter();
if (!(await adapter.isConnected())) {
  await adapter.connect();
}
```

---

## 5. Expo / React Native `crypto.getRandomValues` Missing

### Symptom
```
TypeError: global.crypto.getRandomValues is not a function
```

### Cause
React Native and Expo JS engines lack `globalThis.crypto.getRandomValues` out of the box.

### Solution
Import `@sorostream/sdk-react-native` and invoke `setupExpoPolyfills`:
```ts
import { setupExpoPolyfills } from '@sorostream/sdk-react-native';
setupExpoPolyfills();
```
