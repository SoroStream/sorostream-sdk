# OfflineQueue + CrossTabSync: Combined Multi-Tab Behavior

This document describes how `OfflineWriteQueue` (`src/offlineQueue.ts`) and
`CrossTabSync` (`src/crossTabSync.ts`) interact when both are enabled at the
same time, and how to configure them correctly for multi-tab applications.

---

## Component overview

| Component | Responsibility |
|-----------|---------------|
| `OfflineWriteQueue` | Buffers failed write operations in memory when the RPC is unreachable. Drains them (in priority order) once connectivity is restored. |
| `CrossTabSync` | Broadcasts SDK events (e.g. `cacheInvalidated`, `queueDrained`) to other tabs of the same origin via the `BroadcastChannel` API. |

---

## How they interact

### 1. Queue is per-tab and in-memory

`OfflineWriteQueue` stores operations in a plain array inside the
`SoroStreamClient` instance that created them. Each browser tab runs its own
client instance, so **each tab has its own independent queue**. There is no
shared queue across tabs — there is nothing equivalent to a shared worker or
service worker managing a single cross-tab queue by default.

```
Tab A  ──► SoroStreamClient A ──► OfflineWriteQueue A  (owns operations A1, A2)
Tab B  ──► SoroStreamClient B ──► OfflineWriteQueue B  (owns operations B1)
```

### 2. The tab that enqueued an operation is the one that drains it

Each client's health-check polling (`healthCheckIntervalMs`) runs inside its
own tab. When tab A detects that connectivity is restored, it calls
`OfflineWriteQueue.drain()` for its own queue only. Tab B's queue is drained
by tab B's health-check loop.

> **There is no cross-tab queue hand-off.** If tab A is closed before
> connectivity is restored, its queued operations are lost (they are
> in-memory only).

### 3. Drain events are broadcast to other tabs via CrossTabSync

When a queue drains, `OfflineWriteQueue` emits a `queueDrained` event on the
client's event bus. Because `CrossTabSync` wraps that event bus with
`CrossTabEventBus`, the `queueDrained` event is forwarded to all other open
tabs via `BroadcastChannel`. Other tabs can listen for this event to refresh
their UI or invalidate their caches without issuing additional RPC calls.

```
Tab A: connectivity restored
  └─► OfflineWriteQueue.drain()
        └─► eventBus.emit('queueDrained', results)
              └─► CrossTabEventBus.broadcast('queueDrained', results)
                    └─► Tab B / Tab C receive 'queueDrained'
                              └─► Each tab re-fetches / invalidates cache
```

### 4. Cache-invalidation events are also broadcast

`CrossTabSync` forwards **all** events emitted on the local event bus, not
just `queueDrained`. This means that when a stream is created, cancelled, or
topped up in one tab, the resulting `cacheInvalidated` event is automatically
delivered to the other tabs so their caches stay consistent.

---

## Which tab drains which queue (summary)

| Scenario | Who drains |
|----------|-----------|
| Single tab open | That tab's health-check loop |
| Multiple tabs open, all with connectivity | Each tab drains its own queue independently |
| Tab A enqueued ops, Tab A closed before reconnect | **Operations are lost** (in-memory only) |
| Tab A enqueued ops, Tab B regains connectivity first | Tab B drains *its own* queue only; Tab A's queue is unaffected |

---

## Recommended setup for multi-tab usage

```ts
import { SoroStreamClient } from '@sorostream/sdk';

// Use the same config in every tab.
function createClient(walletAdapter) {
  const client = new SoroStreamClient({
    network: 'mainnet',
    contractId: 'C...',
    walletAdapter,

    // Enable the offline queue in every tab so each tab can buffer
    // its own writes independently.
    offlineQueue: {
      enabled: true,
      maxQueueSize: 50,
      healthCheckIntervalMs: 5_000,   // poll every 5 s for reconnection
    },

    // Enable cross-tab sync so that drain / cache-invalidation events
    // fired in one tab are immediately visible in all others.
    crossTabSync: true,
  });

  // Listen for drains from *any* tab (including your own).
  client.on('queueDrained', ({ totalOperations, successful, failed }) => {
    console.log(`Queue drained: ${successful}/${totalOperations} succeeded, ${failed} failed`);
    // Optionally refresh UI state here.
  });

  return client;
}
```

### Handling operations that must survive tab closure

If your application cannot afford to lose queued writes when a tab closes,
persist operations to `localStorage` (or `IndexedDB`) before enqueuing them,
and restore them in a `visibilitychange` / page-load handler:

```ts
// Before enqueuing, persist the operation to localStorage.
function enqueueWithPersistence(client, operation, params) {
  const pending = JSON.parse(localStorage.getItem('pendingOps') ?? '[]');
  pending.push({ operation, params, queuedAt: Date.now() });
  localStorage.setItem('pendingOps', JSON.stringify(pending));

  client.offlineQueue.enqueue(
    operation,
    () => client[operation](params),
  );
}

// On page load, re-enqueue any operations that survived a tab close.
window.addEventListener('load', () => {
  const pending = JSON.parse(localStorage.getItem('pendingOps') ?? '[]');
  for (const { operation, params } of pending) {
    client.offlineQueue.enqueue(operation, () => client[operation](params));
  }
  // Clear once drained successfully.
  client.on('queueDrained', ({ failed }) => {
    if (failed === 0) localStorage.removeItem('pendingOps');
  });
});
```

---

## Key points to remember

1. **Queues are not shared.** Each tab holds its own in-memory queue.
2. **Draining is local.** A tab only drains its own queue; no tab can drain
   another tab's queue.
3. **Events are shared.** `queueDrained` and all other SDK events emitted by
   one tab are forwarded to every other tab via `CrossTabSync`.
4. **Queued ops are ephemeral.** Closing a tab discards its queue. For
   durable queuing, persist operations to `localStorage` / `IndexedDB`
   separately.
5. **Both features are opt-in** and can be enabled independently; enabling
   `crossTabSync` without `offlineQueue` (or vice-versa) is fully supported.
