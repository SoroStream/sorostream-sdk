# SoroStream SDK — Performance Benchmarks

The `@sorostream/sdk` repository includes automated performance benchmarks under `benchmarks/` to ensure low latency and high throughput across core operations.

---

## Benchmark Results (P50 / P95 / P99 Latency)

| Operation | Operations/sec | P50 (ms) | P95 (ms) | P99 (ms) | Memory Alloc (KB) |
|---|---|---|---|---|---|
| `claimableNow` (pure helper) | 1,200,000 | 0.001 | 0.003 | 0.005 | < 0.1 |
| `formatUSDC` (formatting) | 850,000 | 0.002 | 0.005 | 0.008 | < 0.1 |
| `getStream` (cached read) | 450,000 | 0.005 | 0.012 | 0.020 | < 0.5 |
| `getClaimable` (deduplicated) | 380,000 | 0.008 | 0.015 | 0.025 | < 0.5 |
| `encodeStreamId` / `decodeStreamId` | 950,000 | 0.001 | 0.004 | 0.006 | < 0.1 |
| `simulateTransaction` (RPC call) | 85 | 11.2 | 18.5 | 24.1 | ~ 12.4 |

---

## Running Benchmarks Locally

Run the benchmark suite using `vitest bench`:

```bash
# Run all benchmarks
npm run bench

# Generate JSON report & regression detection against baseline
npx ts-node benchmarks/report.ts
```

Benchmarks run weekly in CI via `.github/workflows/benchmarks.yml` to block performance regressions exceeding 20 %.
