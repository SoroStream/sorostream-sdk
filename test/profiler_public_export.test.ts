/**
 * Issue #758: Verify that profiler exports are reachable via the public
 * package entry point (`@sorostream/sdk`).
 *
 * The profiler module was previously unreachable by any package consumer —
 * not re-exported from index.ts, no subpath export.  This test imports it
 * via the barrel export to confirm the public surface is wired up.
 */
import { describe, it, expect } from 'vitest';

// Import from the barrel re-export, not the deep path
import { GasProfiler } from '../src/index.js';
import type { SimulationProfile, ProfileReport, ProfilerConfig } from '../src/index.js';

describe('Issue #758: profiler exports reachable via public entry point', () => {
  it('GasProfiler is exported and constructable', () => {
    // Use a valid 56-char Stellar contract ID (C + 55 base32 chars)
    const validContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const validPublicKey = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
    const profiler = new GasProfiler({
      network: 'testnet',
      contractId: validContractId,
      publicKey: validPublicKey,
    });
    expect(profiler).toBeInstanceOf(GasProfiler);
  });

  it('SimulationProfile type is importable from the public entry point', () => {
    // Type-only import — if the export is missing, TypeScript compilation fails
    const sample: SimulationProfile = {
      operationType: 'create_stream',
      params: {},
      cpuInstructions: '0',
      minFee: '100',
      ledgerReads: 2,
      ledgerWrites: 1,
      contractEntryBytesRead: 0,
      contractEntryBytesWritten: 0,
      success: true,
    };
    expect(sample.operationType).toBe('create_stream');
  });

  it('ProfileReport type is importable from the public entry point', () => {
    const report: ProfileReport = {
      profiles: [],
      summary: {
        totalCpuInstructions: 0n,
        totalMinFee: 0n,
        totalLedgerReads: 0,
        totalLedgerWrites: 0,
        averageCpuInstructions: 0n,
        averageMinFee: 0n,
      },
    };
    expect(report.profiles).toHaveLength(0);
  });

  it('ProfilerConfig type is importable from the public entry point', () => {
    const config: ProfilerConfig = {
      network: 'testnet',
      contractId: 'C...',
      publicKey: 'G...',
    };
    expect(config.network).toBe('testnet');
  });
});
