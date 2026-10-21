# SoroStream SDK Rate Limiting Mechanisms Guide

The SoroStream SDK provides three distinct rate-limiting and concurrency management mechanisms, each designed for specific layers of execution and traffic characteristics.

---

## 1. Overview of the Three Mechanisms

| Mechanism | Module | Primary Purpose | Scope | Key Configuration |
| :--- | :--- | :--- | :--- | :--- |
| **Concurrency Limiter** | `src/rate-limiter.ts` (`RateLimiter`) | General-purpose async task concurrency throttle (promise worker pool) | Generic tasks / helper execution | `maxConcurrent` |
| **Write Operation Throttler** | `src/writeRateLimiter.ts` (`WriteRateLimiter`) | Token-bucket rate limiting (GCRA) with queue backpressure for on-chain state mutations | SDK write operations (`createStream`, `withdraw`, `cancelStream`, etc.) | `maxPerSecond`, `burst`, `queueSize`, `shared` |
| **RPC Request Priority Queue** | `src/request-queue.ts` (`RequestQueue`) | RPC network-level concurrency control with priority lanes (writes before reads) and queue wait telemetry | Soroban RPC calls | `maxConcurrent`, `priorityLanes`, `rateLimitDelayed` events |

---

## 2. In-Depth Mechanism Breakdown

### A. `RateLimiter` (`src/rate-limiter.ts`)
- **What it governs**: Generic asynchronous functions (`() => Promise<T>`).
- **Algorithm**: FIFO queue with a strict in-flight concurrency cap (`maxConcurrent`).
- **Behavior**: Queues tasks without rejecting until memory is exhausted. Does not inspect time windows or token rates.

### B. `WriteRateLimiter` (`src/writeRateLimiter.ts`)
- **What it governs**: Client-side submission of mutating transactions.
- **Algorithm**: Generic Cell Rate Algorithm (GCRA) token bucket.
- **Behavior**: Throttles operations per second (`maxPerSecond`). When the pending queue exceeds `queueSize`, newly arrived operations are rejected immediately with `RateLimitExceededError` (carrying `queueDepth` and `queueLimit`), applying active backpressure.

### C. `RequestQueue` (`src/request-queue.ts`)
- **What it governs**: Outgoing HTTP/RPC requests made to the Soroban RPC node.
- **Algorithm**: Multi-lane priority queue (e.g., `high`, `write`, `read`).
- **Behavior**: Prioritizes latency-sensitive write operations ahead of batch queries while respecting global `maxConcurrent` limits. Emits telemetry events (`rateLimitDelayed`) for caller observability.

---

## 3. Composition and Interaction

When multiple rate limiters are configured simultaneously:
1. **Application / Write Layer**: The caller triggers an operation (e.g. `client.createStream(...)`). If `WriteRateLimiter` is enabled, it validates transaction burst and token availability, preventing runaway retry loops before building transactions.
2. **RPC Network Layer**: When the transaction is simulated or submitted, `RequestQueue` manages RPC concurrency across nodes and prioritizes write lanes over background polling.
3. **Generic Tasks**: `RateLimiter` can wrap background polling or batch utility operations without interfering with the token bucket state of `WriteRateLimiter`.

---

## 4. Decision Guide for SDK Consumers

- **Use `WriteRateLimiter`** when you want to protect your RPC endpoint from transaction submission floods caused by automated loops or thundering herd scenarios.
- **Use `RequestQueue`** when you have heavy mixed workloads (concurrent reads and writes) and want writes to jump ahead of polling queries while capping simultaneous HTTP connections.
- **Use `RateLimiter`** as a lightweight utility when orchestrating arbitrary concurrent JavaScript tasks or batch scripts outside the SDK's core RPC pipeline.
