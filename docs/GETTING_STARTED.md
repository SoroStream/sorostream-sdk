# Getting Started

This tutorial walks you through a complete integration from scratch. You will install the SDK, connect a wallet, create a payment stream, monitor its claimable balance, and perform a withdrawal.

**Prerequisites:** TypeScript/JavaScript experience. No prior Stellar or Soroban knowledge required.

---

## 1. Installation

```bash
npm install @sorostream/sdk
```

The SDK is fully compatible with Node.js 18+, Bun, and Deno.

---

## 2. Configuration

Create a file `stream-example.ts` and import the SDK:

```typescript
import {
  SoroStreamClient,
  createKeypairAdapter,
  toStroops,
  formatUSDC,
} from "@sorostream/sdk";
```

For this tutorial we use `createKeypairAdapter` (server-side). In a browser you would use `createFreighterAdapter` instead.

Set up environment variables (or hardcode for local testing):

```typescript
const SECRET_KEY  = process.env.STELLAR_SECRET_KEY!;   // starts with "S"
const CONTRACT_ID = process.env.CONTRACT_ID!;          // starts with "C"
const RECIPIENT   = process.env.RECIPIENT!;             // starts with "G"
const USDC_TOKEN  = process.env.USDC_TOKEN!;            // SAC token address
```

> **Where do I get these?**
> - **Secret key:** Generate a Stellar keypair at [laboratory.stellar.org](https://laboratory.stellar.org/#account-creator?network=testnet) and fund it with the [Friendbot](https://laboratory.stellar.org/#account?network=testnet).
> - **Contract ID:** Deploy the SoroStream contract or use a known testnet address from the [SoroStream docs](https://github.com/SoroStream/contract).
> - **USDC token:** On testnet, use the SDF-issued USDC SAC address (`GDRSWS...`).

---

## 3. Connect a Wallet

Create a wallet adapter and instantiate the client:

```typescript
const adapter = createKeypairAdapter(SECRET_KEY);

const client = new SoroStreamClient({
  network: "testnet",
  contractId: CONTRACT_ID,
  walletAdapter: adapter,
});

console.log("Connected as:", await adapter.getPublicKey());
```

The `SoroStreamClient` is your main entry point. It handles transaction building, signing, submission, and polling.

---

## 4. Create Your First Stream

A stream sends a fixed amount of tokens from a sender to a recipient at a constant rate over a set duration.

```typescript
async function createStream() {
  const result = await client.createStream({
    recipient: RECIPIENT,
    token: USDC_TOKEN,
    amount: toStroops("100"),           // 100 USDC
    durationSeconds: 30 * 24 * 60 * 60, // 30 days
    autoRenew: false,
  });

  console.log("Stream created!");
  console.log("  ID :", result.streamId);
  console.log("  Tx :", result.txHash);

  return result.streamId;
}
```

**What happens under the hood?**
1. The SDK validates addresses, amounts, and the recipient's on-chain account.
2. It checks the sender's token allowance for the contract.
3. It builds, simulates, signs, and submits a Soroban transaction.
4. It polls the network until the transaction confirms.
5. It fetches the new stream and returns its ID.

---

## 5. Monitor Claimable Balance

The claimable amount grows every second. You can check it at any time:

```typescript
async function checkBalance(streamId: string) {
  const claimable = await client.getClaimable(streamId);
  console.log(`Claimable: ${formatUSDC(claimable)} USDC`);
}
```

For a live counting-up display, use `watchClaimable`:

```typescript
import { watchClaimable } from "@sorostream/sdk";

const stop = watchClaimable(
  stream,                              // Stream object from getStream()
  () => client.getClaimable(streamId), // reconcile function
  (claimable) => {
    console.log(`  ${formatUSDC(claimable)} USDC claimable`);
  },
  { tickMs: 200, reconcileMs: 5000 }
);

// Later: stop();
```

---

## 6. Perform a Withdrawal

The recipient can withdraw all currently claimable tokens:

```typescript
async function withdraw(streamId: string) {
  const result = await client.withdraw({ streamId });
  console.log(`Withdrew ${formatUSDC(BigInt(result.amount))} USDC`);
  console.log(`Tx hash: ${result.txHash}`);
}
```

> **Note:** `withdraw()` uses the connected wallet adapter's public key as the recipient. Make sure the adapter represents the stream's intended beneficiary.

---

## Complete Example

Here is everything together:

```typescript
import {
  SoroStreamClient,
  createKeypairAdapter,
  toStroops,
  formatUSDC,
} from "@sorostream/sdk";

const SECRET_KEY  = process.env.STELLAR_SECRET_KEY!;
const CONTRACT_ID = process.env.CONTRACT_ID!;
const RECIPIENT   = process.env.RECIPIENT!;
const USDC_TOKEN  = process.env.USDC_TOKEN!;

async function main() {
  const adapter = createKeypairAdapter(SECRET_KEY);
  const client = new SoroStreamClient({
    network: "testnet",
    contractId: CONTRACT_ID,
    walletAdapter: adapter,
  });

  console.log("Sender:", await adapter.getPublicKey());

  const { streamId } = await client.createStream({
    recipient: RECIPIENT,
    token: USDC_TOKEN,
    amount: toStroops("100"),
    durationSeconds: 30 * 24 * 60 * 60,
    autoRenew: false,
  });
  console.log("Created stream:", streamId);

  const claimable = await client.getClaimable(streamId);
  console.log("Claimable:", formatUSDC(claimable), "USDC");

  const result = await client.withdraw({ streamId });
  console.log("Withdrew:", formatUSDC(BigInt(result.amount)), "USDC");
}

main().catch(console.error);
```

Run it:

```bash
export STELLAR_SECRET_KEY="SA..."
export CONTRACT_ID="C..."
export RECIPIENT="G..."
export USDC_TOKEN="G..."
npx tsx stream-example.ts
```

---

## Next Steps

| Topic | Resource |
|-------|----------|
| Plugin system | [PLUGINS.md](./PLUGINS.md) |
| Custom wallet adapters | [CUSTOM_WALLET_ADAPTERS.md](./CUSTOM_WALLET_ADAPTERS.md) |
| Migration from Stellar SDK | [MIGRATION_FROM_STELLAR_SDK.md](./MIGRATION_FROM_STELLAR_SDK.md) |
| Full API reference | [README.md](./README.md) |
| Vesting examples | [examples/](./examples/) |
