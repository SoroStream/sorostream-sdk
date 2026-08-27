# @sorostream/sdk

![npm](https://img.shields.io/npm/v/@sorostream/sdk)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![License](https://img.shields.io/badge/license-MIT-green)
![CI](https://github.com/SoroStream/sorostream-sdk/actions/workflows/test.yml/badge.svg)

TypeScript SDK for the **SoroStream** payment streaming protocol on Stellar Soroban. Stream USDC by the second for salaries, subscriptions, vesting schedules, and grant disbursements.

## Installation

```bash
npm install @sorostream/sdk
```

## Quick Start

```typescript
import { SoroStreamClient, createFreighterAdapter, toStroops } from "@sorostream/sdk";

// 1. Connect wallet
const walletAdapter = await createFreighterAdapter();

// 2. Create client
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "YOUR_CONTRACT_ID",
  walletAdapter,
});

// 3. Create a stream: 100 USDC over 30 days
const { streamId, txHash } = await client.createStream({
  recipient: "GRECIPIENT_ADDRESS",
  token: "GUSDC_TOKEN_ADDRESS",
  amount: toStroops("100"),
  durationSeconds: 30 * 24 * 60 * 60,
  autoRenew: false,
});

// 4. Check claimable balance
const claimable = await client.getClaimable(streamId);

// 5. Withdraw
await client.withdraw({ streamId });
```

## API Reference

### `SoroStreamClient`

| Method | Description |
|--------|-------------|
| `createStream(params)` | Creates a new payment stream. Returns `{ streamId, txHash }` |
| `withdraw(params)` | Withdraws all claimable tokens. Returns `{ txHash, amount }` |
| `batchWithdraw(streamIds, batchSize?)` | Withdraws from multiple streams in one tx. Returns `BatchWithdrawResult[]` |
| `cancelStream(params)` | Cancels stream, refunds sender remainder. Returns `{ txHash }` |
| `topUp(params)` | Adds tokens, extends duration. Returns `{ txHash, newEndTime }` |
| `bulkCreateStreams(rows, options)` | Creates many streams at once (batched). Returns `BulkCreateResult` |
| `getStream(streamId)` | Returns full `Stream` object |
| `getClaimable(streamId)` | Returns claimable amount in stroops |
| `getMultipleStreamBalances(streamIds)` | Returns current claimable balances for many streams in a single batched RPC call, e.g. `[{ streamId, balance }]` |
| `getStreamsBySender(sender)` | Returns all streams for a sender |
| `getStreamsByRecipient(recipient)` | Returns all streams for a recipient |
| `estimateCreateStreamFee(params)` | Estimates network fee for `createStream`. Returns `{ totalFee, minResourceFee }` |
| `estimateWithdrawFee(params)` | Estimates network fee for `withdraw`. Returns `{ totalFee, minResourceFee }` |
| `estimateCancelStreamFee(params)` | Estimates network fee for `cancelStream`. Returns `{ totalFee, minResourceFee }` |
| `estimateTopUpFee(params)` | Estimates network fee for `topUp`. Returns `{ totalFee, minResourceFee }` |
| `getNetwork()` | Returns the resolved network (explicit or auto-detected from `rpcUrl`) |
| `getTokenMetadata(tokenAddress)` | Returns cached or fresh SAC token `{ name, symbol, decimals }` |
| `clearTokenCache(tokenAddress?)` | Clears cached token metadata for one token, or all tokens when omitted |
| `resolveFederationAddress(name)` | Resolves a federation address (`alice*example.com`) to a G-address. Cached for 5 minutes; returns `null` (never throws) if unresolvable |
| `onNetworkChanged(cb)` | Subscribes to wallet-initiated network switches. Returns an unsubscribe function |
| `disconnect()` | Tears down the active RPC transport via its `teardown()` hook, if any (see [CUSTOM_TRANSPORT.md](./CUSTOM_TRANSPORT.md)) |

### Utilities

| Function | Description |
|----------|-------------|
| `toStroops(usdc)` | Converts USDC decimal string to stroops bigint |
| `formatUSDC(stroops)` | Formats stroops bigint to USDC string |
| `calculateFlowRate(amount, duration)` | Returns stroops/second flow rate |
| `claimableNow(stream)` | Estimates current claimable (client-side) |
| `timeUntilStreamEnd(stream)` | Returns seconds until stream ends |
| `calculateVestingSchedule(stream, cliffSeconds, now?)` | Display-only vesting schedule approximating a cliff. **Not enforced on-chain** |
| `watchClaimable(stream, reconcile, onTick, options?)` | Live counting-up ticker for claimable balance. Returns unsubscribe function |
| `filterStreams(streams, filters)` | Filters streams by status, sender, recipient, token, and/or active-only |
| `sortStreams(streams, by, order?)` | Sorts streams by `"startTime"`, `"endTime"`, or `"amount"` |
| `detectNetworkFromRpcUrl(rpcUrl)` | Detects `"testnet"`/`"mainnet"` from an RPC URL, or `undefined` if unrecognized |
| `parseMemo(transaction)` | Decodes the memo from a Horizon transaction record |

### Client Options

| Option | Default | Description |
|--------|---------|-------------|
| `network?` | Auto-detected from `rpcUrl` | Stellar network (`"mainnet"`, `"testnet"`, `"futurenet"`). Required unless `rpcUrl` contains a detectable `"testnet"`/`"mainnet"`/`horizon.stellar.org` hostname |
| `contractId` | â€” | Deployed stream contract address |
| `walletAdapter` | â€” | Wallet adapter for signing |
| `rpcUrl?` | Default per network | Custom RPC URL override; also used for network auto-detection |
| `transport?` | Wraps `rpc.Server` at `rpcUrl` | Custom `RpcTransportAdapter` for all Soroban RPC calls — see [CUSTOM_TRANSPORT.md](./CUSTOM_TRANSPORT.md) |
| `txTimeoutMs?` | `120000` | Max time (ms) to wait for transaction confirmation |
| `checkDuplicate?` | `false` | Heuristic check to warn/block duplicate stream creation |
| `tokenMetadataTtlMs?` | `600000` | TTL (ms) for cached `getTokenMetadata()` results |
| `onNetworkChange?` | â€” | Called when the connected wallet switches networks mid-session |
| `skipPeerCheck?` | `false` | Skips the `@stellar/stellar-sdk` peer version compatibility check |
| `telemetry?` | `true` | Set to `false` to opt out of any SDK telemetry now and in future releases. No data is collected as of this version. See [TELEMETRY.md](./TELEMETRY.md) for the full policy |

All mutation methods (`createStream`, `withdraw`, `cancelStream`, `topUp`) accept an optional `AbortSignal` as the last argument to cancel in-flight transactions.

All write methods also accept a `memo` field on their `WriteOptions` argument (e.g. `client.withdraw(params, signal, { memo: "invoice-123" })`) to tag the transaction for off-chain reconciliation. A `string` is encoded as `MEMO_TEXT` (28-byte limit); a 32-byte `Buffer` is encoded as `MEMO_HASH`. Use `parseMemo()` to decode a memo back out of a Horizon transaction record.

| Method | Description |
|--------|-------------|
| `executeBatch(operations)` | Submits multiple operations in a single transaction |
| `aggregateStreamsByToken(streams)` | Groups streams by token, returns per-token totals |
| `parseCsvStreamRows(csv)` | Parses CSV string into `BulkStreamRow[]` |

### Wallet

| Function | Description |
|----------|-------------|
| `createFreighterAdapter()` | Creates a WalletAdapter backed by Freighter extension |
| `createKeypairAdapter(secretKey)` | Creates a WalletAdapter from a Stellar secret key (server-side) |
| `createLedgerAdapter({ transport, path? })` | Creates a WalletAdapter backed by a Ledger device |
| `connectWallet()` | Prompts Freighter connection, returns public key |

The `WalletAdapter` interface (see `src/types.ts`) is the official extension point for custom signing backends. Implement `getPublicKey`, `signTransaction`, and `isConnected` to support any wallet or signing service. See the [wallet adapter examples](#wallet-adapter-examples) below for copy-pasteable testnet patterns.

### Wallet adapter examples

#### Freighter adapter

```ts
import { SoroStreamClient, createFreighterAdapter } from "@sorostream/sdk";

const freighterAdapter = await createFreighterAdapter();
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "YOUR_CONTRACT_ID",
  walletAdapter: freighterAdapter,
});
```

#### Ledger adapter

```ts
import { TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import TransportWebUSB from "@ledgerhq/hw-transport-webusb";
import AppStr from "@ledgerhq/hw-app-str";
import type { WalletAdapter, Network } from "@sorostream/sdk";

async function signWithLedger(xdr: string, network: Network) {
  const transport = await TransportWebUSB.create();
  const app = new AppStr(transport);
  const path = "m/44'/148'/0'/0/0";
  const tx = TransactionBuilder.fromXDR(
    xdr,
    network === "testnet" ? Networks.TESTNET : network === "futurenet" ? Networks.FUTURENET : Networks.PUBLIC,
  );

  const signature = await app.signTransaction(path, tx.hash());
  await transport.close();

  return signature;
}

const ledgerAdapter: WalletAdapter = {
  async isConnected() {
    return true;
  },
  async getPublicKey() {
    const transport = await TransportWebUSB.create();
    const app = new AppStr(transport);
    const result = await app.getAddress("m/44'/148'/0'/0/0");
    await transport.close();
    return result.address;
  },
  async signTransaction(xdr, network) {
    const signature = await signWithLedger(xdr, network);
    return signature;
  },
};
```

#### Server-side keypair adapter

```ts
import { SoroStreamClient, createKeypairAdapter } from "@sorostream/sdk";

const serverKeypairAdapter = createKeypairAdapter(process.env.STELLAR_SECRET!);
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "YOUR_CONTRACT_ID",
  walletAdapter: serverKeypairAdapter,
});
```

### Deno and Bun Compatibility

The SDK is fully compatible with modern JS/TS runtimes, including **Deno** and **Bun**.

#### Bun Usage
```bash
bun install @sorostream/sdk
```
You can import the SDK and use it directly in Bun scripts:
```typescript
import { SoroStreamClient, createKeypairAdapter } from "@sorostream/sdk";
```

#### Deno Usage
You can run/import the SDK directly using NPM imports:
```typescript
import { SoroStreamClient, createKeypairAdapter } from "npm:@sorostream/sdk";
```

### Server-side Usage

For backend scripts and automated payouts, use `createKeypairAdapter`:

```typescript
import { SoroStreamClient, createKeypairAdapter, toStroops } from "@sorostream/sdk";

const adapter = createKeypairAdapter("SAZ...YOUR...SECRET...KEY...");
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "YOUR_CONTRACT_ID",
  walletAdapter: adapter,
});

// Bulk-create payroll streams from CSV
const csv = `recipient,amount,durationSeconds
GABCD...1,100000000,2592000
GABCD...2,50000000,604800`;
const rows = parseCsvStreamRows(csv);
const { batches } = await client.bulkCreateStreams(rows, {
  token: "GUSDC_TOKEN_ADDRESS",
});
console.log(`Created ${batches.length} batch(es)`);
```

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](./GETTING_STARTED.md) | Step-by-step tutorial from installation to withdrawal |
| [Plugins](./PLUGINS.md) | Plugin/middleware system reference with worked examples |
| [Custom Wallet Adapters](./CUSTOM_WALLET_ADAPTERS.md) | How to build adapters for unsupported wallets |
| [Custom Transport Adapters](./CUSTOM_TRANSPORT.md) | How to route RPC calls through your own transport layer |
| [Migration from Stellar SDK](./MIGRATION_FROM_STELLAR_SDK.md) | Before/after mapping of common operations |
| [Stream State Machine](./docs/state-machine.md) | Mermaid diagram of all stream states and valid / invalid transitions |
| [Rate Limiting](./docs/rate-limiting.md) | Default polling intervals, network call frequency, and tuning advice |
| [linear-vesting.ts](./examples/linear-vesting.ts) | Constant-rate stream with no cliff |
| [cliff-linear-vesting.ts](./examples/cliff-linear-vesting.ts) | Cliff period followed by linear release |
| [milestone-vesting.ts](./examples/milestone-vesting.ts) | Fixed tranches released at scheduled dates |
| [logging-middleware.ts](./examples/logging-middleware.ts) | Plugin system worked example |

## JSON Schema validation

Non-TypeScript tooling (Python/Go scripts assembling stream-creation payloads, for example) can validate against JSON Schema files generated from the SDK's own TypeScript types, published at `@sorostream/sdk/schemas/*`:

- `sorostream-client-config.schema.json` — `SoroStreamClientConfig`, the JSON-serializable subset of `SoroStreamClientOptions`
- `create-stream-params.schema.json` — `CreateStreamParams`
- `stream-filter.schema.json` — `StreamFilter`

```js
const Ajv = require("ajv");
const schema = require("@sorostream/sdk/schemas/create-stream-params.schema.json");
const ajv = new Ajv();
const validate = ajv.compile(schema);
validate({ recipient: "G...", token: "C...", amount: "100000000", durationSeconds: 3600, autoRenew: false });
```

Schemas are regenerated with `npm run generate-schemas` (or `sorostream-generate-schemas` from a repo checkout) and kept in sync with the TypeScript source by a CI check (`npm run check:schemas`).

## Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚          Your App / UI          â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
               â”‚ imports
               â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚        @sorostream/sdk          â”‚
â”‚                                 â”‚
â”‚  SoroStreamClient               â”‚
â”‚    â”œâ”€ WalletAdapter (sign txs)  â”‚
â”‚    â”œâ”€ Cache (optimistic reads)  â”‚
â”‚    â””â”€ CircuitBreaker / Retry    â”‚
â”‚                                 â”‚
â”‚  Utils (pure helpers)           â”‚
â”‚    â”œâ”€ toStroops / formatUSDC    â”‚
â”‚    â”œâ”€ claimableNow / isExpired  â”‚
â”‚    â””â”€ calculateVestingSchedule  â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
               â”‚ Stellar RPC (simulateTransaction / sendTransaction)
               â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚   SoroStream Contract (Soroban) â”‚
â”‚   github.com/SoroStream/contractâ”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

**SoroStreamClient** is the primary entry point. It handles transaction building, signing, submission, polling, and retry logic. It exposes both mutation methods (`createStream`, `withdraw`, `topUp`, â€¦) and read methods (`getStream`, `getClaimable`, â€¦).

**WalletAdapters** decouple signing from the client. Three are built-in â€” `createFreighterAdapter` (browser extension), `createKeypairAdapter` (server-side secret key), and `createLedgerAdapter` (hardware wallet). Implement `WalletAdapter` to add any custom signer.

**Utils** are pure functions with no network dependency. Use them for client-side estimates (`claimableNow`, `isExpired`), display formatting (`formatUSDC`, `toStroops`), and display-only vesting schedules (`calculateVestingSchedule`). They can run in any JS/TS environment including Deno and Bun.

Contract source: [github.com/SoroStream/contract](https://github.com/SoroStream/contract) Â· Example app: [github.com/SoroStream/app](https://github.com/SoroStream/app)

## Migrating from v0.x

See [docs/migration-v1.md](./docs/migration-v1.md) for a full list of breaking changes with before/after examples.

## Local Setup

```bash
npm install
npm test        # run unit tests
npm run lint    # type check
npm run build   # build to dist/
```

## Contributing via Drips Wave

This project participates in the **Stellar Wave Program** on [Drips Wave](https://drips.network/wave). Contributors earn rewards for resolving issues during weekly Wave sprints.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

> **Note:** Do not start coding until assigned to an issue by a maintainer.
