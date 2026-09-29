# SoroStream SDK — Real-World Examples

This guide provides copy-pasteable, production-ready TypeScript code examples for common integration patterns with `@sorostream/sdk`.

---

## 1. React / Next.js Stream Creation & Live Status

```tsx
import React, { useState, useEffect } from 'react';
import { SoroStreamClient, toStroops, formatUSDC } from '@sorostream/sdk';
import { createFreighterAdapter } from '@sorostream/sdk/wallets';

export function CreateStreamForm() {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('100');
  const [status, setStatus] = useState<string | null>(null);

  async function handleCreateStream(e: React.FormEvent) {
    e.preventDefault();
    setStatus('Connecting wallet...');

    try {
      const walletAdapter = await createFreighterAdapter();
      const client = new SoroStreamClient({
        network: 'testnet',
        contractId: process.env.NEXT_PUBLIC_CONTRACT_ID!,
        walletAdapter,
      });

      setStatus('Submitting transaction...');
      const { streamId, txHash } = await client.createStream({
        recipient,
        token: process.env.NEXT_PUBLIC_USDC_CONTRACT!,
        amount: toStroops(amount),
        durationSeconds: 30 * 24 * 60 * 60, // 30 days
        autoRenew: false,
      });

      setStatus(`Stream created! ID: ${streamId}, Tx: ${txHash}`);
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  }

  return (
    <form onSubmit={handleCreateStream}>
      <input
        type="text"
        placeholder="Recipient Address (G...)"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        required
      />
      <input
        type="number"
        placeholder="Amount in USDC"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
      />
      <button type="submit">Start Payment Stream</button>
      {status && <p>{status}</p>}
    </form>
  );
}
```

---

## 2. Automated Server-Side Payroll Stream Management

```ts
import { SoroStreamClient, toStroops } from '@sorostream/sdk';
import { createKeypairAdapter } from '@sorostream/sdk/wallets';

async function runPayrollBatch() {
  const walletAdapter = createKeypairAdapter(process.env.STELLAR_SECRET_KEY!);

  const client = new SoroStreamClient({
    network: 'testnet',
    contractId: process.env.CONTRACT_ID!,
    walletAdapter,
  });

  const employees = [
    { recipient: 'GBX...', amount: '2500' },
    { recipient: 'GAY...', amount: '3100' },
    { recipient: 'GCI...', amount: '1800' },
  ];

  const rows = employees.map((emp) => ({
    recipient: emp.recipient,
    token: process.env.USDC_TOKEN!,
    amount: toStroops(emp.amount),
    durationSeconds: 30 * 24 * 60 * 60,
    autoRenew: true,
  }));

  console.log('Dispatching bulk stream creation...');
  const result = await client.bulkCreateStreams(rows, {
    batchSize: 50,
    onProgress: (progress) => {
      console.log(`Processed ${progress.completed} of ${progress.total} employees`);
    },
  });

  console.log(`Successfully created ${result.successes.length} payroll streams!`);
}
```

---

## 3. Real-Time Stream Dashboard with RxJS Observable

```ts
import { SoroStreamClient, formatUSDC } from '@sorostream/sdk';

async function watchUserStreams(streamId: string) {
  const client = new SoroStreamClient({
    network: 'testnet',
    contractId: process.env.CONTRACT_ID!,
  });

  // Observe live claimable balance changes
  const subscription = client.observeStream(streamId).subscribe({
    next: (stream) => {
      if (stream) {
        console.log(`Stream ${stream.id} status: ${stream.status}`);
        console.log(`Flow Rate: ${stream.flowRate} stroops/sec`);
      }
    },
    error: (err) => console.error('Observer error:', err),
    complete: () => console.log('Stream concluded or cancelled.'),
  });

  // Clean up subscription when component unmounts
  return () => subscription.unsubscribe();
}
```

---

## 4. React Native & Expo Storage Integration

```ts
import * as SecureStore from 'expo-secure-store';
import { SoroStreamClient } from '@sorostream/sdk';
import { createExpoAdapters, setupExpoPolyfills } from '@sorostream/sdk-react-native';

// Polyfill global.crypto for Expo / React Native
setupExpoPolyfills();

const client = new SoroStreamClient({
  network: 'testnet',
  contractId: 'C...',
  adapters: createExpoAdapters({ secureStore: SecureStore }),
});
```
