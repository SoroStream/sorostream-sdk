# @sorostream/react

React hooks for [SoroStream](https://github.com/SoroStream/sorostream-sdk). Built on the `@sorostream/sdk` client to manage payment streams, claimable balances, and stream lifecycles effortlessly in React applications.

> Requires `react` `^18.0.0` or `^19.0.0` and `@sorostream/sdk` `>=0.1.0`.

## Installation

```bash
npm install @sorostream/react @sorostream/sdk react
```

## Available Hooks

### `useStream`
Subscribe to live updates for a single stream.

```tsx
import { useStream } from '@sorostream/react';

function StreamComponent({ client, streamId }) {
  const { stream, claimable, loading, error } = useStream(client, streamId);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <h3>Stream #{stream.id}</h3>
      <p>Claimable: {claimable} USDC</p>
    </div>
  );
}
```

### `useStreamList`
Fetch and optionally poll a list of payment streams.

```tsx
import { useStreamList } from '@sorostream/react';

function StreamList({ client, senderAddress }) {
  const { streams, loading, error, refresh } = useStreamList(client, {
    sender: senderAddress,
    pollMs: 5000,
  });

  return (
    <div>
      <button onClick={refresh}>Refresh</button>
      {streams.map((s) => (
        <div key={s.id}>{s.id}</div>
      ))}
    </div>
  );
}
```

### `useCreateStream`
Create a new stream.

```tsx
import { useCreateStream } from '@sorostream/react';

function CreateStreamButton({ client }) {
  const { createStream, loading, error } = useCreateStream(client);

  const handleCreate = async () => {
    await createStream({
      recipient: 'G...',
      token: 'C...',
      amount: '100',
      duration: 3600,
    });
  };

  return <button onClick={handleCreate} disabled={loading}>Create Stream</button>;
}
```

### `useWithdraw`
Withdraw claimable tokens from a stream.

```tsx
import { useWithdraw } from '@sorostream/react';

function WithdrawButton({ client, streamId }) {
  const { withdraw, loading, error, txHash, amount } = useWithdraw(client);

  return (
    <button onClick={() => withdraw(streamId)} disabled={loading}>
      Withdraw
    </button>
  );
}
```

## License

MIT
