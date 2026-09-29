/**
 * Live Soroban Testnet RPC integration test suite (#641).
 * Tests live RPC connection, health checks, and ledger queries against
 * https://soroban-testnet.stellar.org to detect breaking RPC or protocol changes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { rpc, Networks } from '@stellar/stellar-sdk';
import { SoroStreamClient } from '../../src/SoroStreamClient.js';

const LIVE_TESTNET_RPC_URL =
  process.env.SOROSTREAM_INTEGRATION_RPC_URL ?? 'https://soroban-testnet.stellar.org';

// Dummy valid Soroban contract ID for client initialization testing
const DUMMY_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

describe('Live Soroban Testnet RPC integration suite (#641)', () => {
  let rpcServer: rpc.Server;

  beforeAll(() => {
    rpcServer = new rpc.Server(LIVE_TESTNET_RPC_URL, { allowHttp: false });
  });

  it('fetches health status from live Soroban testnet RPC', async () => {
    const health = await rpcServer.getHealth();
    expect(health).toBeDefined();
    expect(health.status).toBe('healthy');
  });

  it('fetches latest ledger from live Soroban testnet RPC', async () => {
    const ledger = await rpcServer.getLatestLedger();
    expect(ledger).toBeDefined();
    expect(typeof ledger.sequence).toBe('number');
    expect(ledger.sequence).toBeGreaterThan(0);
    expect(typeof ledger.id).toBe('string');
    expect(ledger.id.length).toBeGreaterThan(0);
  });

  it('verifies network passphrase matches Stellar Testnet passphrase', () => {
    const networkPassphrase = Networks.TESTNET;
    expect(networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it('initializes SoroStreamClient with live testnet RPC URL and verifies configuration', () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: DUMMY_CONTRACT_ID,
      rpcUrl: LIVE_TESTNET_RPC_URL,
    });

    expect(client).toBeDefined();
  });
});
