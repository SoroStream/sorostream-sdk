import { describe, it, expect, vi, beforeEach } from "vitest";
import { SoroStreamClient } from "../src/SoroStreamClient.js";
import { MockSoroStreamClient } from "../src/mock.js";
import { Keypair } from "@stellar/stellar-sdk";
import { createKeypairAdapter } from "../src/wallet.js";
import { InsufficientAmountError, SelfStreamError } from "../src/errors.js";
import type { CreateStreamDryRunResult } from "../src/types.js";

describe("Issue #439: Dry-run mode for createStream parameter validation and simulation", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const senderKp = Keypair.random();
  const recipientKp = Keypair.random();
  const tokenAddress = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  it("throws during local validation when amount is invalid even in dryRun mode", async () => {
    const mockClient = new MockSoroStreamClient({
      network: "testnet",
      contractId,
      walletAdapter: createKeypairAdapter(senderKp.secret()),
    });

    await expect(
      mockClient.createStream(
        {
          recipient: recipientKp.publicKey(),
          token: tokenAddress,
          amount: 0n,
          durationSeconds: 3600,
          autoRenew: false,
        },
        undefined,
        { dryRun: true }
      )
    ).rejects.toThrow(InsufficientAmountError);
  });

  it("throws SelfStreamError if sender equals recipient in dryRun mode", async () => {
    const client = new SoroStreamClient({
      network: "testnet",
      contractId,
      walletAdapter: createKeypairAdapter(senderKp.secret()),
    });

    await expect(
      client.createStream(
        {
          recipient: senderKp.publicKey(),
          token: tokenAddress,
          amount: 1000_0000000n,
          durationSeconds: 3600,
          autoRenew: false,
        },
        undefined,
        { dryRun: true }
      )
    ).rejects.toThrow(SelfStreamError);
  });

  it("simulates transaction without broadcasting when options.dryRun is true", async () => {
    const mockTransport = {
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => senderKp.publicKey(),
        sequenceNumber: () => "1",
        incrementSequenceNumber: () => {},
      }),
      getHealth: vi.fn().mockResolvedValue({ status: "healthy" }),
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
      getTransaction: vi.fn(),
      simulateTransaction: vi.fn().mockResolvedValue({
        id: "sim-123",
        minResourceFee: "150",
        events: [],
        transactionData: {},
      }),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getEvents: vi.fn(),
    };

    const client = new SoroStreamClient({
      network: "testnet",
      contractId,
      walletAdapter: createKeypairAdapter(senderKp.secret()),
      transport: mockTransport as any,
    });

    const streamParams = {
      recipient: recipientKp.publicKey(),
      token: tokenAddress,
      amount: 500_0000000n,
      durationSeconds: 3600,
      autoRenew: false,
      skipAllowanceCheck: true,
    };

    const result = (await client.createStream(streamParams, undefined, {
      dryRun: true,
    })) as CreateStreamDryRunResult;

    expect(result.dryRun).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.expectedFee).toBe("150");
    expect(result.minResourceFee).toBe("150");
    expect(result.result).toBeDefined();
    expect(result.params).toEqual(streamParams);

    expect(mockTransport.simulateTransaction).toHaveBeenCalled();
    expect(mockTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("supports dryRun flag inside CreateStreamParams", async () => {
    const mockClient = new MockSoroStreamClient();
    const result = (await mockClient.createStream({
      recipient: recipientKp.publicKey(),
      token: tokenAddress,
      amount: 100_0000000n,
      durationSeconds: 1800,
      autoRenew: false,
      dryRun: true,
    })) as CreateStreamDryRunResult;

    expect(result.dryRun).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.expectedFee).toBeDefined();
  });
});
