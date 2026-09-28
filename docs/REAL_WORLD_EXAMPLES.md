# SoroStream SDK — Real-World Integration Examples

This document provides complete, copy-pasteable, production-ready code examples for common integration patterns with `@sorostream/sdk`.

---

## 1. Client Initialization & Wallet Adapters

### Browser Integration (Freighter Extension)

```typescript
import { SoroStreamClient, createFreighterAdapter } from '@sorostream/sdk';

async function initBrowserClient() {
  const freighterAdapter = await createFreighterAdapter();

  const client = new SoroStreamClient({
    network: 'testnet',
    contractId: 'CCW67TSB3SSS4ZXMBO5W2XZPOKOA26HK2Y2S282CREOSIFD23YJG37KZ',
    walletAdapter: freighterAdapter,
  });

  return client;
}
```

### Server-Side Backend Worker (Secret Keypair)

```typescript
import { SoroStreamClient, createKeypairAdapter } from '@sorostream/sdk';

function initServerClient() {
  const secretKey = process.env.STELLAR_SECRET_KEY!;
  const keypairAdapter = createKeypairAdapter(secretKey);

  return new SoroStreamClient({
    network: 'mainnet',
    contractId: 'C...YOUR_CONTRACT_ADDRESS',
    rpcUrl: 'https://soroban-rpc.mainnet.stellar.org',
    walletAdapter: keypairAdapter,
  });
}
```

---

## 2. Creating Payroll & Vesting Payment Streams

### Standard Employee Payroll Stream (Monthly)

```typescript
import { SoroStreamClient, toStroops } from '@sorostream/sdk';

async function createMonthlyPayroll(client: SoroStreamClient, employeeAddress: string) {
  const USDC_TOKEN = 'CCW67TSB3SSS4ZXMBO5W2XZPOKOA26HK2Y2S282CREOSIFD23YJG37KZ';
  const monthlySalaryStroops = toStroops('5000.00'); // 5,000 USDC
  const duration30Days = 30 * 24 * 60 * 60; // 30 days in seconds

  const { streamId, txHash } = await client.createStream({
    recipient: employeeAddress,
    token: USDC_TOKEN,
    amount: monthlySalaryStroops,
    durationSeconds: duration30Days,
    autoRenew: true, // Auto-renew payroll monthly
  });

  console.log(`Payroll stream created! Stream ID: ${streamId}, Tx: ${txHash}`);
  return streamId;
}
```

### Token Vesting Stream with 6-Month Cliff

```typescript
import { SoroStreamClient, toStroops } from '@sorostream/sdk';

async function createVestingStream(client: SoroStreamClient, founderAddress: string) {
  const totalVestingStroops = toStroops('100000.00'); // 100,000 USDC
  const fourYearsSeconds = 4 * 365 * 24 * 60 * 60;
  const sixMonthsCliffSeconds = 180 * 24 * 60 * 60;

  const result = await client.createStream({
    recipient: founderAddress,
    token: 'C...TOKEN_ADDRESS',
    amount: totalVestingStroops,
    durationSeconds: fourYearsSeconds,
    cliffSeconds: sixMonthsCliffSeconds,
    autoRenew: false,
  });

  console.log(`Vesting stream active: ${result.streamId}`);
}
```

---

## 3. Real-Time Stream Monitoring & Balance Calculation

```typescript
import { SoroStreamClient, formatUSDC, calculateVestingSchedule } from '@sorostream/sdk';

async function monitorStream(client: SoroStreamClient, streamId: string) {
  // Fetch on-chain stream details
  const stream = await client.getStream(streamId);
  console.log(`Stream Status: ${stream.status}`);

  // Fetch real-time claimable balance
  const claimableStroops = await client.getClaimable(streamId);
  console.log(`Claimable Balance: ${formatUSDC(claimableStroops)} USDC`);

  // Calculate off-chain display schedule
  const schedule = calculateVestingSchedule(stream, 0);
  console.log(`Vesting Progress: ${schedule.progressPercentage.toFixed(2)}%`);
}
```

---

## 4. Batch Operations

```typescript
import { SoroStreamClient, toStroops } from '@sorostream/sdk';

async function batchDisbursePayroll(client: SoroStreamClient, recipients: string[]) {
  const USDC_TOKEN = 'CCW67TSB3SSS4ZXMBO5W2XZPOKOA26HK2Y2S282CREOSIFD23YJG37KZ';
  const duration30Days = 30 * 86400;

  const batchParams = recipients.map((recipient) => ({
    recipient,
    token: USDC_TOKEN,
    amount: toStroops('2500.00'),
    durationSeconds: duration30Days,
    autoRenew: true,
  }));

  const { txHash, streamIds } = await client.createStreamsBatch(batchParams);
  console.log(`Batch created ${streamIds.length} streams in tx: ${txHash}`);
}
```

---

## 5. Resilient Error Handling & Retry Configuration

```typescript
import { SoroStreamClient, CircuitBreakerOpenError } from '@sorostream/sdk';

async function resilientOperation(client: SoroStreamClient, streamId: string) {
  try {
    const result = await client.withdraw({ streamId });
    console.log(`Withdrawal successful: ${result.txHash}`);
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      console.warn('RPC endpoint rate limited or failing. Circuit breaker is OPEN. Retrying later...');
    } else {
      console.error('Operation failed:', error);
    }
  }
}
```
