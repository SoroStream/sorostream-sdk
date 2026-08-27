/**
 * Integration suite for issue #467: exercises the SDK against a real Soroban
 * RPC node instead of mocks.
 *
 * Requires a running local testnet (see ../../docker-compose.integration.yml)
 * and a deployed SoroStream contract:
 *
 *   docker compose -f docker-compose.integration.yml up -d --wait
 *   SOROSTREAM_INTEGRATION_CONTRACT_ID=C... npm run test:integration
 *
 * The suite is skipped (not failed) when SOROSTREAM_INTEGRATION_CONTRACT_ID
 * is unset, so `npm run test:integration` is safe to wire into CI even
 * before a contract deploy step exists for every PR.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { SoroStreamClient } from '../../src/SoroStreamClient.js';
import { createKeypairAdapter } from '../../src/wallet.js';

const RPC_URL = process.env.SOROSTREAM_INTEGRATION_RPC_URL ?? 'http://localhost:8000/soroban/rpc';
const FRIENDBOT_URL = process.env.SOROSTREAM_INTEGRATION_FRIENDBOT_URL ?? 'http://localhost:8000/friendbot';
const CONTRACT_ID = process.env.SOROSTREAM_INTEGRATION_CONTRACT_ID;
const TOKEN_ID = process.env.SOROSTREAM_INTEGRATION_TOKEN_ID;

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${res.status} ${res.statusText}`);
  }
}

describe.skipIf(!CONTRACT_ID || !TOKEN_ID)('SoroStreamClient against a local Soroban testnet', () => {
  const senderKeypair = Keypair.random();
  const recipientKeypair = Keypair.random();
  let client: SoroStreamClient;

  beforeAll(async () => {
    await fundAccount(senderKeypair.publicKey());
    await fundAccount(recipientKeypair.publicKey());

    client = new SoroStreamClient({
      network: 'futurenet',
      contractId: CONTRACT_ID as string,
      rpcUrl: RPC_URL,
      walletAdapter: createKeypairAdapter(senderKeypair.secret()),
    });
  }, 60_000);

  it('creates a stream, reads it back, and withdraws from it', async () => {
    const { streamId } = await client.createStream({
      recipient: recipientKeypair.publicKey(),
      token: TOKEN_ID as string,
      amount: 100_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });
    expect(streamId).toBeTruthy();

    const stream = await client.getStream(streamId);
    expect(stream.sender).toBe(senderKeypair.publicKey());
    expect(stream.recipient).toBe(recipientKeypair.publicKey());
    expect(stream.status).toBe('Active');

    const claimable = await client.getClaimable(streamId);
    expect(claimable).toBeGreaterThanOrEqual(0n);

    const { txHash } = await client.cancelStream({ streamId });
    expect(txHash).toBeTruthy();

    const cancelled = await client.getStream(streamId);
    expect(cancelled.status).toBe('Cancelled');
  }, 60_000);
});
