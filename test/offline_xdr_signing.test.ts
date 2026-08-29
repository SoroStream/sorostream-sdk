import { describe, it, expect } from "vitest";
import { Account, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildUnsignedXdr } from "../src/serialization.js";
import { SoroStreamClient } from "../src/SoroStreamClient.js";
import { Keypair } from "@stellar/stellar-sdk";

describe("Issue #438: Unsigned XDR serialization helper for offline/air-gapped signing", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const sourceKey = Keypair.random().publicKey();
  const recipientKey = Keypair.random().publicKey();
  const tokenAddress = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  it("builds valid unsigned XDR for createStream operation", () => {
    const xdrStr = buildUnsignedXdr("createStream", {
      contractId,
      sourceAccount: sourceKey,
      recipient: recipientKey,
      token: tokenAddress,
      amount: 1000_0000000n,
      durationSeconds: 3600,
      network: "testnet",
    });

    expect(typeof xdrStr).toBe("string");
    expect(xdrStr.length).toBeGreaterThan(0);

    const tx = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
    expect(tx.source).toBe(sourceKey);
    expect(tx.operations.length).toBe(1);
    expect(tx.operations[0]!.type).toBe("invokeHostFunction");
  });

  it("builds valid unsigned XDR for withdraw and cancel operations", () => {
    const withdrawXdr = buildUnsignedXdr("withdraw", {
      contractId,
      sourceAccount: recipientKey,
      streamId: "123",
      recipient: recipientKey,
      network: "testnet",
    });
    const withdrawTx = TransactionBuilder.fromXDR(withdrawXdr, Networks.TESTNET);
    expect(withdrawTx.operations.length).toBe(1);

    const cancelXdr = buildUnsignedXdr("cancelStream", {
      contractId,
      sourceAccount: sourceKey,
      streamId: "123",
      network: "testnet",
    });
    const cancelTx = TransactionBuilder.fromXDR(cancelXdr, Networks.TESTNET);
    expect(cancelTx.operations.length).toBe(1);
  });

  it("supports topUp, updateFlowRate, pause, resume, and transferStream", () => {
    const topUpXdr = buildUnsignedXdr("topUp", {
      contractId,
      sourceAccount: sourceKey,
      streamId: "123",
      amount: 500_0000000n,
    });
    expect(TransactionBuilder.fromXDR(topUpXdr, Networks.TESTNET)).toBeDefined();

    const pauseXdr = buildUnsignedXdr("pauseStream", {
      contractId,
      sourceAccount: sourceKey,
      streamId: "123",
    });
    expect(TransactionBuilder.fromXDR(pauseXdr, Networks.TESTNET)).toBeDefined();

    const resumeXdr = buildUnsignedXdr("resumeStream", {
      contractId,
      sourceAccount: sourceKey,
      streamId: "123",
    });
    expect(TransactionBuilder.fromXDR(resumeXdr, Networks.TESTNET)).toBeDefined();

    const transferXdr = buildUnsignedXdr("transferStream", {
      contractId,
      sourceAccount: sourceKey,
      streamId: "123",
      newRecipient: recipientKey,
    });
    expect(TransactionBuilder.fromXDR(transferXdr, Networks.TESTNET)).toBeDefined();
  });

  it("accepts custom Account object, sequence number, memo, fee, and timeout", () => {
    const account = new Account(sourceKey, "42");
    const xdrStr = buildUnsignedXdr("withdraw", {
      contractId,
      sourceAccount: account,
      streamId: "1",
      fee: "200",
      memo: "offline-signing",
      timeout: 60,
    });

    const tx = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
    expect(tx.sequence).toBe("43");
    expect(String(tx.fee)).toBe("200");
    expect(tx.memo.value?.toString()).toBe("offline-signing");
    expect(tx.timeBounds?.maxTime).toBeDefined();
  });

  it("supports passing raw xdr.Operation directly", () => {
    const contract = new (require("@stellar/stellar-sdk").Contract)(contractId);
    const op = contract.call("withdraw", require("@stellar/stellar-sdk").nativeToScVal("1", { type: "string" }));

    const xdrStr = buildUnsignedXdr(op, {
      sourceAccount: sourceKey,
      network: "testnet",
    });

    const tx = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
    expect(tx.operations.length).toBe(1);
  });

  it("supports client.buildUnsignedXdr method", async () => {
    const client = new SoroStreamClient({
      network: "testnet",
      contractId,
    });

    const xdrStr = await client.buildUnsignedXdr("createStream", {
      sourceAccount: sourceKey,
      recipient: recipientKey,
      token: tokenAddress,
      amount: 100n,
      durationSeconds: 60,
    });

    expect(typeof xdrStr).toBe("string");
    const tx = TransactionBuilder.fromXDR(xdrStr, Networks.TESTNET);
    expect(tx.source).toBe(sourceKey);
  });

  it("throws error when contractId is missing for string operation name", () => {
    expect(() =>
      buildUnsignedXdr("createStream", {
        sourceAccount: sourceKey,
      })
    ).toThrow("contractId is required");
  });

  it("throws error for unsupported operation name", () => {
    expect(() =>
      buildUnsignedXdr("invalidOpName", {
        contractId,
        sourceAccount: sourceKey,
      })
    ).toThrow("Unsupported operation name");
  });
});
