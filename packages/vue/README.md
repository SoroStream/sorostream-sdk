# @sorostream/vue

Vue 3 composables for [SoroStream](https://github.com/SoroStream/sorostream-sdk). Built on the
[`@sorostream/sdk`](#) client and its reactive primitives — `observeStream()` (RxJS-compatible
observable) and the batched `getStreams()` reader — so your components stay in sync with on-chain
stream state without hand-rolling polling or dedup logic.

> Requires `vue` `^3.3` and `@sorostream/sdk` `>=0.1`.

## Install

```bash
npm install @sorostream/vue @sorostream/sdk vue
```

## Composables

### `useStream` — live single stream

```ts
import { useStream } from '@sorostream/vue';

const { stream, claimable, loading, error } = useStream(
  () => client.value,
  () => streamId.value,
);
```

- Inputs accept a value, a `ref`, or a getter (so `useStream(() => client, () => id)` re-subscribes
  when the id changes).
- Binds to the SDK's `observeStream()` observable, so the `stream` ref updates automatically and
  the shared poll loop tears down when the composable's effect scope is disposed.
- `loading` is `true` until the first value arrives; `error` carries the last rejection.

### `useStreamList` — batched table of streams

```ts
import { useStreamList } from '@sorostream/vue';

// By ids — one get_streams RPC call for the whole list:
const { streams, loading, error, refresh } = useStreamList(() => client, { ids: () => ids.value });

// Or by sender / recipient:
const { streams } = useStreamList(() => client, { sender: () => account.value });
```

- `query` is one of `{ ids }`, `{ sender }`, or `{ recipient }` (`ids` is an array or getter).
- Uses the batched reader, so N streams cost a single RPC call (chunked at `batchReadSize`).
- Optional `pollMs` enables periodic refresh; omit for event-driven updates only.

### `useWithdraw` — claim tokens

```ts
import { useWithdraw } from '@sorostream/vue';

const { withdraw, loading, error, txHash, amount } = useWithdraw(() => client);

async function onClaim(streamId: string) {
  await withdraw(streamId); // txHash / amount populate on success
}
```

- `withdraw(streamId)` submits the claim; `loading`, `error`, `txHash`, and `amount` track the
  submission lifecycle.

All composables export fully typed reactive refs and clean up automatically on scope disposal
(`onScopeDispose`), so they are safe to use in components, `<script setup>`, and tests with
`effectScope()`.
