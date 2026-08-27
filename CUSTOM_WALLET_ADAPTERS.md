# Custom Wallet Adapters

The `WalletAdapter` interface lets you add support for any Stellar wallet or signing backend. Implement the three required methods and plug it into `SoroStreamClient`.

---

## Interface Definition

```typescript
interface WalletAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, network: Network): Promise<string>;
  isConnected(): Promise<boolean>;
}
```

| Method | Required | Description |
|--------|----------|-------------|
| `getPublicKey()` | Yes | Returns the Stellar public key (G...) of the connected account. |
| `signTransaction(xdr, network)` | Yes | Signs a Soroban transaction envelope (base64 XDR) and returns the signed envelope (base64 XDR). |
| `isConnected()` | Yes | Returns whether the wallet is available and the user has granted access. |

### `Network` type

```typescript
type Network = "mainnet" | "testnet" | "futurenet";
```

### Error Handling

- `signTransaction` should throw if the user rejects the signing request.
- `getPublicKey` should throw if the wallet is locked or disconnected.
- `isConnected` should never throw — return `false` instead.
- All methods can return a rejected promise for unrecoverable errors.

---

## Walkthrough: Implementing a Minimal Adapter

Suppose you want to add support for a fictional `MockWallet`. Here is a minimal implementation:

```typescript
import type { WalletAdapter, Network } from "@sorostream/sdk";
import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

export function createMockWalletAdapter(secretKey: string): WalletAdapter {
  const kp = Keypair.fromSecret(secretKey);

  return {
    async isConnected(): Promise<boolean> {
      return true;
    },

    async getPublicKey(): Promise<string> {
      return kp.publicKey();
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      const tx = TransactionBuilder.fromXDR(
        xdrStr,
        NETWORK_PASSPHRASES[network]
      );
      tx.sign(kp);
      return tx.toEnvelope().toXDR("base64");
    },
  };
}
```

Usage:

```typescript
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter: createMockWalletAdapter("SA..."),
});
```

---

## Reference Implementation: Freighter Adapter

The built-in Freighter adapter (at `src/wallet.ts:70`) is the canonical example of a browser-based wallet adapter:

```typescript
export async function createFreighterAdapter(): Promise<WalletAdapter> {
  const freighter = await import("@stellar/freighter-api");

  return {
    async isConnected(): Promise<boolean> {
      const result = await freighter.isConnected();
      return result.isConnected;
    },

    async getPublicKey(): Promise<string> {
      const result = await freighter.getAddress();
      if (result.error) throw new Error(result.error.message);
      return result.address;
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      const result = await freighter.signTransaction(xdrStr, {
        networkPassphrase: NETWORK_PASSPHRASES[network],
      });
      if (result.error) throw new Error(result.error.message);
      return result.signedTxXdr;
    },
  };
}
```

Key patterns to follow:
- **Dynamic import** the wallet SDK to avoid SSR/code-splitting issues.
- **Throw on error** — the client treats thrown errors as failures.
- **Use `NETWORK_PASSPHRASES`** to map the SDK's `Network` enum to Stellar passphrases.
- **Return raw base64 XDR** — the client handles envelope parsing.

---

## Other Built-in Adapters

These live in `src/wallet.ts` and serve as additional reference implementations:

| Adapter | Line | Environment |
|---------|------|-------------|
| `createKeypairAdapter` | `src/wallet.ts:113` | Node.js (secret key) |
| `createClaimDelegateAdapter` | `src/wallet.ts:161` | Node.js (claim bot pattern) |
| `createMultisigAdapter` | `src/wallet.ts:190` | Node.js (multi-signature) |
| `createPasskeyAdapter` | `src/wallet.ts:301` | Browser (WebAuthn) |
| `createLedgerAdapter` | `src/wallet.ts:424` | Browser (Ledger hardware) |

---

## Exporting Your Adapter

If you publish a custom adapter as an npm package, export the factory function and the `WalletAdapter` type:

```typescript
// my-wallet-adapter/index.ts
import type { WalletAdapter } from "@sorostream/sdk";
export function createMyWalletAdapter(options: {...}): WalletAdapter {
  // ...
}
export type { WalletAdapter };
```

Consumers import both and pass the adapter directly:

```typescript
import { SoroStreamClient } from "@sorostream/sdk";
import { createMyWalletAdapter } from "my-wallet-adapter";

const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter: createMyWalletAdapter({ ... }),
});
```
