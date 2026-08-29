/**
 * End-to-end integration suite for issue #527: exercises the full SDK surface
 * (client initialisation, stream creation, top-up, pause, resume, withdrawal, and cancellation)
 * against a live Soroban Testnet deployment.
 *
 * Requires a running testnet environment and a deployed SoroStream contract:
 *   SOROSTREAM_INTEGRATION_CONTRACT_ID=C... npm run test:integration
 *
 * The suite is skipped when SOROSTREAM_INTEGRATION_CONTRACT_ID is unset.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { SoroStreamClient } from '../../src/SoroStreamClient.js';
import { createKeypairAdapter } from '../../src/wallet.js';

const RPC_URL = process.env.SOROSTREAM_INTEGRATION_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const FRIENDBOT_URL = process.env.SOROSTREAM_INTEGRATION_FRIENDBOT_URL ?? 'https://friendbot.stellar.org';
const CONTRACT_ID = process.env.SOROSTREAM_INTEGRATION_CONTRACT_ID;
const TOKEN_ID = process.env.SOROSTREAM_INTEGRATION_TOKEN_ID ?? 'CDLZFC3SYJYDVR7P6JC4D2DB51MY5H4M3JVEEOCXN6B7L3EQI7SZZ2B3';

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${res.status} ${res.statusText}`);
  }
}

describe.skipIf(!CONTRACT_ID)('SoroStreamClient end-to-end live Soroban Testnet integration suite', () => {
  const senderKeypair = Keypair.random();
  const recipientKeypair = Keypair.random();
  let client: SoroStreamClient;

  beforeAll(async () => {
    await fundAccount(senderKeypair.publicKey());
    await fundAccount(recipientKeypair.publicKey());

    // 1. Client initialisation
    client = new SoroStreamClient({
      network: 'testnet',
      contractId: CONTRACT_ID as string,
      rpcUrl: RPC_URL,
      walletAdapter: createKeypairAdapter(senderKeypair.secret()),
    });
  }, 60_000);

  it('exercises full SDK lifecycle: create, top-up, pause, resume, withdraw, and cancel', async () => {
    // 2. Stream creation
    const { streamId } = await client.createStream({
      recipient: recipientKeypair.publicKey(),
      token: TOKEN_ID,
      amount: 100_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });
    expect(streamId).toBeTruthy();

    const stream = await client.getStream(streamId);
    expect(stream.sender).toBe(senderKeypair.publicKey());
    expect(stream.recipient).toBe(recipientKeypair.publicKey());
    expect(stream.status).toBe('Active');

    // 3. Top-up stream
    const topUpResult = await client.topUp({
      streamId,
      amount: 50_000_000n,
    });
    expect(topUpResult.txHash).toBeTruthy();

    // 4. Pause stream
    const pauseResult = await client.pause({ streamId });
    expect(pauseResult.txHash).toBeTruthy();

    const pausedStream = await client.getStream(streamId);
    expect(pausedStream.status).toBe('Paused');

    // 5. Resume stream
    const resumeResult = await client.resume({ streamId });
    expect(resumeResult.txHash).toBeTruthy();

    const resumedStream = await client.getStream(streamId);
    expect(resumedStream.status).toBe('Active');

    // 6. Withdrawal from stream
    const claimable = await client.getClaimable(streamId);
    expect(claimable).toBeGreaterThanOrEqual(0n);
    const withdrawResult = await client.withdraw({ streamId });
    expect(withdrawResult.txHash).toBeTruthy();

    // 7. Cancellation
    const cancelResult = await client.cancelStream({ streamId });
    expect(cancelResult.txHash).toBeTruthy();

    const cancelledStream = await client.getStream(streamId);
    expect(cancelledStream.status).toBe('Cancelled');
  }, 120_000);
});
