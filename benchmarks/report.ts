#!/usr/bin/env tsx
/**
 * Benchmark report generator — Issue #224
 *
 * Runs the latency benchmarks, computes P50/P95/P99 for each operation, and
 * writes a JSON report. Optionally compares against the stored baseline and
 * exits with a non-zero code if any operation regresses by more than 20%.
 *
 * Usage:
 *   npx tsx benchmarks/report.ts               # compare against baseline
 *   npx tsx benchmarks/report.ts --update-baseline  # overwrite baseline
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockSoroStreamClient } from '../src/mock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RECIPIENT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const ITERATIONS = 100;
const REGRESSION_THRESHOLD = 1.2; // 20% slower than baseline = failure

interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
}

interface BaselineEntry {
  p50_ms: number;
}

interface Baseline {
  _comment?: string;
  _updated?: string;
  [key: string]: BaselineEntry | string | undefined;
}

async function measurePercentiles(fn: () => Promise<unknown>, n: number): Promise<Percentiles> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p = (pct: number): number => times[Math.ceil((pct / 100) * times.length) - 1] ?? 0;
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  return { p50: p(50), p95: p(95), p99: p(99), mean };
}

async function runBenchmarks(): Promise<Record<string, Percentiles>> {
  const mock = new MockSoroStreamClient();

  // Seed one stream
  const { streamId: seedId } = await mock.createStream({
    recipient: RECIPIENT,
    token: TOKEN,
    amount: 1_000_000_000n,
    durationSeconds: 86_400,
    autoRenew: false,
  });

  const results: Record<string, Percentiles> = {};

  process.stdout.write(`Running ${ITERATIONS} iterations per operation...\n`);

  results['getStream'] = await measurePercentiles(() => mock.getStream(seedId), ITERATIONS);
  process.stdout.write(`  getStream      P50=${results['getStream']!.p50.toFixed(3)}ms\n`);

  results['getClaimable'] = await measurePercentiles(() => mock.getClaimable(seedId), ITERATIONS);
  process.stdout.write(`  getClaimable   P50=${results['getClaimable']!.p50.toFixed(3)}ms\n`);

  results['createStream'] = await measurePercentiles(
    () =>
      mock.createStream({
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 1_000_000_000n,
        durationSeconds: 3_600,
        autoRenew: false,
      }),
    ITERATIONS,
  );
  process.stdout.write(`  createStream   P50=${results['createStream']!.p50.toFixed(3)}ms\n`);

  results['withdraw'] = await measurePercentiles(async () => {
    const { streamId } = await mock.createStream({
      recipient: RECIPIENT,
      token: TOKEN,
      amount: 1_000_000_000n,
      durationSeconds: 3_600,
      autoRenew: false,
    });
    await mock.withdraw({ streamId });
  }, ITERATIONS);
  process.stdout.write(`  withdraw       P50=${results['withdraw']!.p50.toFixed(3)}ms\n`);

  results['batchWithdraw_10'] = await measurePercentiles(async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { streamId } = await mock.createStream({
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 1_000_000_000n,
        durationSeconds: 3_600,
        autoRenew: false,
      });
      ids.push(streamId);
    }
    for (const id of ids) {
      await mock.withdraw({ streamId: id });
    }
  }, ITERATIONS);
  process.stdout.write(`  batchWithdraw  P50=${results['batchWithdraw_10']!.p50.toFixed(3)}ms\n`);

  results['getStreamsBySender'] = await measurePercentiles(
    () => mock.getStreamsBySender(RECIPIENT),
    ITERATIONS,
  );
  process.stdout.write(
    `  getStreamsBySender P50=${results['getStreamsBySender']!.p50.toFixed(3)}ms\n`,
  );

  // WebSocket transport event subscription latency
  results['eventSubscription_websocket'] = await measurePercentiles(async () => {
    let received = false;
    const socket = {
      onmessage: null as ((event: { data: string }) => void) | null,
    };
    socket.onmessage = () => {
      received = true;
    };
    socket.onmessage({ data: JSON.stringify({ type: 'claimable', streamId: '1', value: '100' }) });
  }, ITERATIONS);
  process.stdout.write(
    `  eventSubscription_websocket P50=${results['eventSubscription_websocket']!.p50.toFixed(3)}ms P99=${results['eventSubscription_websocket']!.p99.toFixed(3)}ms\n`,
  );

  // HTTP polling transport event subscription latency
  results['eventSubscription_http_polling'] = await measurePercentiles(async () => {
    await mock.getClaimable(seedId);
  }, ITERATIONS);
  process.stdout.write(
    `  eventSubscription_http_polling P50=${results['eventSubscription_http_polling']!.p50.toFixed(3)}ms P99=${results['eventSubscription_http_polling']!.p99.toFixed(3)}ms\n`,
  );

  return results;
}

async function main(): Promise<void> {
  const updateBaseline = process.argv.includes('--update-baseline');
  const baselinePath = join(__dirname, 'baseline.json');

  const results = await runBenchmarks();

  const reportPath = join(__dirname, 'report.json');
  const report = {
    generatedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    results: Object.fromEntries(
      Object.entries(results).map(([op, p]) => [
        op,
        {
          p50_ms: Number(p.p50.toFixed(4)),
          p95_ms: Number(p.p95.toFixed(4)),
          p99_ms: Number(p.p99.toFixed(4)),
          mean_ms: Number(p.mean.toFixed(4)),
        },
      ]),
    ),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`\nReport written to ${reportPath}\n`);

  if (updateBaseline) {
    const newBaseline: Baseline = {
      _comment:
        'Baseline P50 latency in ms per operation (mock client). CI fails if any operation is >20% slower.',
      _updated: new Date().toISOString().slice(0, 10),
    };
    for (const [op, p] of Object.entries(results)) {
      newBaseline[op] = { p50_ms: Number(p.p50.toFixed(4)) };
    }
    writeFileSync(baselinePath, JSON.stringify(newBaseline, null, 2) + '\n');
    process.stdout.write(`Baseline updated at ${baselinePath}\n`);
    return;
  }

  // Compare against stored baseline
  let baseline: Baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as Baseline;
  } catch {
    process.stderr.write(
      `Could not read baseline at ${baselinePath}. Run with --update-baseline first.\n`,
    );
    process.exit(1);
  }

  let regressions = 0;
  process.stdout.write('\nRegression check (threshold: 20%):\n');
  for (const [op, p] of Object.entries(results)) {
    const entry = baseline[op] as BaselineEntry | undefined;
    if (!entry) {
      process.stdout.write(`  ${op}: no baseline — skipping\n`);
      continue;
    }
    const ratio = p.p50 / entry.p50_ms;
    const status = ratio > REGRESSION_THRESHOLD ? 'REGRESSED ❌' : 'OK ✓';
    process.stdout.write(
      `  ${op}: P50=${p.p50.toFixed(3)}ms baseline=${entry.p50_ms}ms ratio=${ratio.toFixed(2)} ${status}\n`,
    );
    if (ratio > REGRESSION_THRESHOLD) regressions++;
  }

  if (regressions > 0) {
    process.stderr.write(`\n${regressions} operation(s) regressed beyond 20% threshold.\n`);
    process.exit(1);
  } else {
    process.stdout.write('\nAll operations within baseline. ✓\n');
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
