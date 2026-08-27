# Code Examples

Runnable TypeScript scripts for common vesting patterns. Each example targets **testnet** and requires a funded keypair.

## Prerequisites

```bash
export STELLAR_SECRET_KEY="SA..."   # funded testnet keypair
export CONTRACT_ID="C..."           # deployed SoroStream contract
export RECIPIENT="G..."             # recipient Stellar address
export USDC_TOKEN="G..."            # USDC SAC token address
```

## Examples

| Script | Description |
|---|---|
| [linear-vesting.ts](./linear-vesting.ts) | Streams tokens at a constant rate from day 0 with no cliff |
| [cliff-linear-vesting.ts](./cliff-linear-vesting.ts) | Holds tokens for a cliff period then releases them linearly |
| [milestone-vesting.ts](./milestone-vesting.ts) | Releases fixed tranches at scheduled dates via separate streams |
| [logging-middleware.ts](./logging-middleware.ts) | Demonstrates the plugin/middleware system with a logging plugin |

## Running

```bash
npx tsx examples/linear-vesting.ts
npx tsx examples/cliff-linear-vesting.ts
npx tsx examples/milestone-vesting.ts
```
