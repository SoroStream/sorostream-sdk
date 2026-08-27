# SoroStream SDK Benchmark Suite

Issue #224 — Measures SDK operation latency on a local Soroban quickstart sandbox
to separate RPC overhead from SDK code overhead, and to detect regressions.

## Structure

```
benchmarks/
  latency.bench.ts      P50/P95/P99 latency for getStream, getClaimable, createStream, withdraw
  report.ts             JSON report generator — compares run results against a stored baseline
  baseline.json         Stored baseline for CI regression checks (updated manually on intentional changes)
```

## Running

### Quick run (100 iterations per operation, local mock)

```bash
npx vitest bench --reporter=verbose benchmarks/
```

### Against a real local sandbox (requires soroban-quickstart)

```bash
SOROBAN_RPC_URL=http://localhost:8000/soroban/rpc \
SOROBAN_CONTRACT_ID=<your-contract-id> \
SOROBAN_SECRET=S... \
npx vitest bench --reporter=verbose benchmarks/
```

### Generate a JSON report

```bash
npx tsx benchmarks/report.ts
```

## CI Schedule

Benchmarks run weekly on the `scheduled-benchmarks` workflow, **not** on every PR.
See `.github/workflows/benchmarks.yml`.

## Baseline

`benchmarks/baseline.json` stores the expected P50 latency per operation.
CI fails if any operation regresses by more than **20 %** against the baseline.

To update the baseline after an intentional improvement or environment change:

```bash
npx tsx benchmarks/report.ts --update-baseline
```
