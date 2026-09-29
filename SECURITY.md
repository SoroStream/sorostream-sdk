# Security Best Practices

This document describes security recommendations for integrators of `@sorostream/sdk`.

> **Vulnerability disclosure:** To report a security vulnerability, please see [Reporting a Vulnerability](#reporting-a-vulnerability) at the bottom of this document.

---

## Table of Contents

1. [Secret Key Management](#1-secret-key-management)
2. [Wallet Adapter Security](#2-wallet-adapter-security)
3. [Transport Security & TLS Enforcement](#3-transport-security--tls-enforcement)
4. [Rate Limiting & Replay Protection](#4-rate-limiting--replay-protection)
5. [Nonce / Idempotency Keys](#5-nonce--idempotency-keys)
6. [Input Validation](#6-input-validation)
7. [Dependency & Supply-Chain Security](#7-dependency--supply-chain-security)
8. [Reporting a Vulnerability](#reporting-a-vulnerability)

---

## 1. Secret Key Management

Stellar secret keys (those beginning with `S`) grant full control over an account's funds. Treat them with
the same care as database passwords or private TLS keys.

### ❌ What NOT to do

```ts
// NEVER hard-code secret keys in source code
const client = new SoroStreamClient({
  signerKey: "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXO",
  rpcUrl: "https://rpc.mainnet.stellar.org",
  network: "mainnet",
});
```

```ts
// NEVER commit .env files containing real keys to version control
// BAD: .env (in git)
SOROSTREAM_SECRET_KEY=SBXXXXX...
```

### ✅ Recommended approach

**Environment variables — server-side only:**

```ts
// Load at runtime, never bundle into client-side code
const signerKey = process.env.SOROSTREAM_SECRET_KEY;
if (!signerKey) throw new Error("SOROSTREAM_SECRET_KEY is required");

const client = new SoroStreamClient({ signerKey, rpcUrl: "...", network: "mainnet" });
```

Add `.env` to `.gitignore`:

```gitignore
.env
.env.local
.env.*.local
```

**Use a secrets manager in production:**

| Platform | Tool |
|---|---|
| AWS | AWS Secrets Manager / SSM Parameter Store |
| GCP | Secret Manager |
| Azure | Key Vault |
| Self-hosted | HashiCorp Vault |

**Rotate keys regularly** and revoke any key that may have been exposed.

**Never expose secret keys on the client side.** Browser-based applications should always use a
hardware wallet adapter (Freighter, Ledger) or a server-side signing proxy — never a raw secret key.

---

## 2. Wallet Adapter Security

The SDK ships several wallet adapters. Choose the one that matches your environment and threat model.

### Freighter Browser Extension (Recommended for browser apps)

Freighter keeps the private key inside the extension — your dApp never sees it.

```ts
import { createFreighterAdapter } from "@sorostream/sdk/wallets";

const wallet = createFreighterAdapter();
const client = new SoroStreamClient({
  walletAdapter: wallet,
  rpcUrl: "https://rpc.mainnet.stellar.org",
  network: "mainnet",
});
```

**Security considerations:**
- Always verify `wallet.isConnected()` before signing — Freighter can lock between calls.
- The SDK automatically re-runs the connection handshake after a lock/unlock cycle (v1.0.0+, #410).
- Prompt the user to confirm the transaction in the extension before submitting.

### Ledger Hardware Wallet

Ledger stores the private key in secure element hardware and requires physical button confirmation.

```ts
import { createLedgerAdapter } from "@sorostream/sdk/wallets";
import TransportWebUSB from "@ledgerhq/hw-transport-webusb";

const transport = await TransportWebUSB.create();
const wallet = createLedgerAdapter({ transport });
```

**Security considerations:**
- Require users to verify the transaction details on the Ledger screen before approving.
- Close the transport when done: `await transport.close()`.
- Use `@ledgerhq/hw-transport-webusb` for browsers; `@ledgerhq/hw-transport-node-hid` for Node.js.

### Albedo

Albedo is a web-based transaction signer that keeps keys in the user's browser storage.

```ts
import { createAlbedoAdapter } from "@sorostream/sdk/wallets";

const wallet = createAlbedoAdapter();
```

**Security considerations:**
- Inform users that Albedo stores keys in browser local storage — suitable for testnet / low-value flows.
- For mainnet high-value transactions, prefer Freighter or Ledger.

### KMS Signing Proxy (Server-side)

For server-side signing without exposing secret keys to the application layer, use a KMS adapter that
delegates signing to AWS KMS, GCP Cloud KMS, or HashiCorp Vault.

```ts
// Example: custom KMS adapter
const wallet = {
  getPublicKey: async () => await kmsClient.getPublicKey(keyId),
  signTransaction: async (tx) => await kmsClient.sign(keyId, tx),
};

const client = new SoroStreamClient({ walletAdapter: wallet, /* ... */ });
```

### WalletConnect v2

```ts
import { createWalletConnectAdapter } from "@sorostream/sdk/wallets";

const wallet = createWalletConnectAdapter({ projectId: "YOUR_PROJECT_ID" });
```

**Security considerations:**
- The SDK now detects and handles expired / deleted WalletConnect sessions automatically (#453).
- `WalletConnectSessionExpiredError` is thrown when a stale session is detected — catch it and prompt
  the user to reconnect.
- Always use a project ID registered at [cloud.walletconnect.com](https://cloud.walletconnect.com).

---

## 3. Transport Security & TLS Enforcement

Starting in v1.0.0, the SDK **automatically rejects** non-TLS RPC URLs at construction time.

### What this means

```ts
// ❌ Throws InsecureRpcUrlError in v1.0.0+
const client = new SoroStreamClient({
  rpcUrl: "http://rpc.example.com",   // Non-TLS — rejected
  network: "mainnet",
});
```

```ts
// ✅ Correct
const client = new SoroStreamClient({
  rpcUrl: "https://rpc.mainnet.stellar.org",  // TLS — accepted
  network: "mainnet",
});
```

**Loopback exception:** `http://localhost`, `http://127.0.0.1`, and `http://[::1]` remain allowed for
local Soroban Quickstart development.

### Handling `InsecureRpcUrlError`

```ts
import { InsecureRpcUrlError } from "@sorostream/sdk";

try {
  const client = new SoroStreamClient({ rpcUrl, network: "mainnet" });
} catch (err) {
  if (err instanceof InsecureRpcUrlError) {
    throw new Error(`Insecure RPC URL rejected: ${err.message}`);
  }
  throw err;
}
```

### Additional transport recommendations

- **Pin your RPC endpoint** to a trusted provider (e.g., Blockdaemon, QuickNode, or your own node).
- **Validate TLS certificates** — never disable certificate verification in production.
- **Use HTTP/2** where available for multiplexed RPC connections.

---

## 4. Rate Limiting & Replay Protection

### Client-Side Rate Limiting (`writeRateLimit`)

Protect your RPC endpoint from accidental flooding due to runaway loops or retry storms:

```ts
const client = new SoroStreamClient({
  rpcUrl: "https://rpc.mainnet.stellar.org",
  network: "mainnet",
  writeRateLimit: {
    maxPerSecond: 5,   // Maximum write operations per second
    burst: 10,         // Allow short bursts up to this many ops
    shared: false,     // Set true to share the limiter across multiple client instances
  },
});
```

Write operations (`createStream`, `withdraw`, `cancelStream`, `createStreams`, `batchWithdraw`, etc.) that
exceed the limit are **queued and delayed**, not rejected, so no data is lost.

**When to use `shared: true`:**

```ts
// Share a single rate limiter across clients for the same RPC endpoint
const client1 = new SoroStreamClient({ writeRateLimit: { maxPerSecond: 5, shared: true }, /* ... */ });
const client2 = new SoroStreamClient({ writeRateLimit: { maxPerSecond: 5, shared: true }, /* ... */ });
// Both clients share the 5 req/s budget
```

### Replay Attack Mitigation

Use the `nonce` field on `createStream` to ensure each stream creation request is unique:

```ts
import { createStream } from "@sorostream/sdk";

await client.createStream({
  recipient: "G...",
  nonce: crypto.randomUUID(), // Unique per request — prevents replay
  // ...
});
```

See [Section 5](#5-nonce--idempotency-keys) for full nonce documentation.

---

## 5. Nonce / Idempotency Keys

The `nonce` field on `CreateStreamParams` ties each create operation to a unique caller-supplied key.
If the same transaction is replayed (e.g., by a network retry), the contract recognises the nonce and
returns the existing stream rather than creating a duplicate.

```ts
import { NonceNotSupportedError } from "@sorostream/sdk";

// Pre-flight check
const supported = await client.supportsNonce();

try {
  await client.createStream(
    {
      recipient: "G...",
      nonce: crypto.randomUUID(),
      // ...
    },
    { strict: supported } // Throw if contract doesn't support nonces
  );
} catch (err) {
  if (err instanceof NonceNotSupportedError) {
    // Contract version does not support nonces — handle accordingly
    console.warn("Nonce not supported by this contract version.");
  }
}
```

**Best practices:**
- Store the nonce alongside the intended stream parameters before submitting.
- On retry, reuse the **same** nonce — do not generate a new one.
- Nonces are per-sender; different senders may reuse the same nonce string without collision.

---

## 6. Input Validation

The SDK validates critical inputs, but you should validate at your application boundary as well.

### Amount validation

```ts
import { toStroops } from "@sorostream/sdk";

// toStroops converts decimal XLM strings to stroop bigints (1 XLM = 10,000,000 stroops)
const amount = toStroops("10.5");   // 105_000_000n

// Validate before passing user input
const raw = userInput.trim();
if (!/^\d+(\.\d{1,7})?$/.test(raw)) {
  throw new Error("Invalid amount");
}
const safeAmount = toStroops(raw);
```

### Address validation

```ts
import { StrKey } from "@stellar/stellar-sdk";

function assertValidAddress(address: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(`Invalid Stellar address: ${address}`);
  }
}

assertValidAddress(recipientInput); // Validate before calling SDK
```

### Memo validation

```ts
import { encodeMemo, SoroStreamMemoError } from "@sorostream/sdk";

try {
  const memo = encodeMemo(userMemoInput); // Throws if > 28 bytes
} catch (err) {
  if (err instanceof SoroStreamMemoError) {
    console.error("Memo is too long — must be ≤ 28 bytes.");
  }
}
```

### JSON Schema validation

The SDK publishes machine-readable JSON Schemas for `SoroStreamClientConfig`, `CreateStreamParams`, and
`StreamFilter` at `@sorostream/sdk/schemas/*`. Use them with `ajv` or any Draft-07 validator:

```ts
import Ajv from "ajv";
import createStreamSchema from "@sorostream/sdk/schemas/CreateStreamParams.json";

const ajv = new Ajv();
const validate = ajv.compile(createStreamSchema);

if (!validate(userParams)) {
  throw new Error(`Invalid params: ${ajv.errorsText(validate.errors)}`);
}
```

---

## 7. Dependency & Supply-Chain Security

### Automated audit in CI

The SDK ships a `Security` GitHub Actions workflow (`.github/workflows/security.yml`) that runs
`npm audit --audit-level=high --omit=dev` on every PR and push to `main`. To run it locally:

```bash
npm run check:audit
```

### Lock-file integrity

- Always commit `package-lock.json` to version control.
- Use `npm ci` (not `npm install`) in CI to ensure deterministic installs from the lock file.
- Consider enabling [npm provenance](https://docs.npmjs.com/generating-provenance-statements) when publishing.

### Sub-resource integrity for CDN usage

When loading the SDK from a CDN, use the Subresource Integrity (SRI) attribute to ensure the script
has not been tampered with:

```html
<script
  src="https://unpkg.com/@sorostream/sdk/dist/sorostream.global.js"
  integrity="sha384-REPLACE_WITH_ACTUAL_HASH"
  crossorigin="anonymous"
></script>
```

Generate the hash with:

```bash
openssl dgst -sha384 -binary dist/sorostream.global.js | openssl base64 -A
```

The SDK's `npm run generate-integrity` script writes integrity hashes for all `dist/` outputs to
`dist/integrity-manifest.json` after every build.

---

## Reporting a Vulnerability

> [!CAUTION]
> **Do NOT open a public GitHub issue for security vulnerabilities.** Public disclosure before a fix is
> available puts all SDK users at risk.

To report a security vulnerability in `@sorostream/sdk`:

1. **Email:** Send details to `security@sorostream.io` with the subject line `[SECURITY] sorostream-sdk`.
2. **Include:**
   - A description of the vulnerability and its potential impact.
   - Steps to reproduce or a minimal proof-of-concept.
   - Affected SDK versions.
3. **Response time:** We aim to acknowledge reports within **48 hours** and provide a fix timeline within
   **7 business days** for critical issues.
4. **Coordinated disclosure:** We follow responsible disclosure practices. We will credit reporters in the
   release notes unless they prefer to remain anonymous.

For general security questions (not vulnerability reports), open a discussion at
[github.com/SoroStream/sorostream-sdk/discussions](https://github.com/SoroStream/sorostream-sdk/discussions).
