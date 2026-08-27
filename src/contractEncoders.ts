import { Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { ContractVersion, CreateStreamParams, SplitStreamParams } from "./types.js";

export interface ContractCallEncoder {
  createStream(sender: string, params: CreateStreamParams): xdr.Operation;
  withdraw(streamId: string, recipient: string): xdr.Operation;
  cancelStream(streamId: string, sender: string): xdr.Operation;
  topUp(streamId: string, sender: string, amount: bigint): xdr.Operation;
  updateFlowRate(streamId: string, sender: string, newFlowRate: bigint): xdr.Operation;
  setOperator(streamId: string, sender: string, operator: string, approved: boolean): xdr.Operation;
  operatorCancelStream(streamId: string, operator: string): xdr.Operation;
  operatorTopUp(streamId: string, operator: string, amount: bigint): xdr.Operation;
  splitStream(sender: string, params: SplitStreamParams): xdr.Operation;
  transferStream(streamId: string, sender: string, newRecipient: string): xdr.Operation;
  pauseStream(streamId: string, sender: string): xdr.Operation;
  resumeStream(streamId: string, sender: string): xdr.Operation;
}

class V1Encoder implements ContractCallEncoder {
  constructor(private contract: Contract) {}

  createStream(sender: string, params: CreateStreamParams): xdr.Operation {
    return this.contract.call(
      "create_stream",
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.recipient, { type: "address" }),
      nativeToScVal(params.token, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" }),
      nativeToScVal(params.durationSeconds, { type: "u64" }),
      nativeToScVal(params.autoRenew, { type: "bool" })
    );
  }

  withdraw(streamId: string, recipient: string): xdr.Operation {
    return this.contract.call(
      "withdraw",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(recipient, { type: "address" })
    );
  }

  cancelStream(streamId: string, sender: string): xdr.Operation {
    return this.contract.call(
      "cancel_stream",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );
  }

  topUp(streamId: string, sender: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      "top_up",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(amount, { type: "i128" })
    );
  }

  updateFlowRate(streamId: string, sender: string, newFlowRate: bigint): xdr.Operation {
    return this.contract.call(
      "update_flow_rate",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(newFlowRate, { type: "i128" })
    );
  }

  setOperator(streamId: string, sender: string, operator: string, approved: boolean): xdr.Operation {
    return this.contract.call(
      "set_operator",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(operator, { type: "address" }),
      nativeToScVal(approved, { type: "bool" })
    );
  }

  operatorCancelStream(streamId: string, operator: string): xdr.Operation {
    return this.contract.call(
      "operator_cancel_stream",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(operator, { type: "address" })
    );
  }

  operatorTopUp(streamId: string, operator: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      "operator_top_up",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(operator, { type: "address" }),
      nativeToScVal(amount, { type: "i128" })
    );
  }

  splitStream(sender: string, params: SplitStreamParams): xdr.Operation {
    return this.contract.call(
      "split_stream",
      nativeToScVal(BigInt(params.streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.ratioNumerator, { type: "u64" }),
      nativeToScVal(params.ratioDenominator, { type: "u64" }),
      nativeToScVal(params.recipientA, { type: "address" }),
      nativeToScVal(params.recipientB, { type: "address" })
    );
  }

  transferStream(streamId: string, sender: string, newRecipient: string): xdr.Operation {
    return this.contract.call(
      "transfer_stream",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(newRecipient, { type: "address" })
    );
  }

  pauseStream(streamId: string, sender: string): xdr.Operation {
    return this.contract.call(
      "pause_stream",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );
  }

  resumeStream(streamId: string, sender: string): xdr.Operation {
    return this.contract.call(
      "resume_stream",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );
  }
}

class V2Encoder extends V1Encoder {
  constructor(contract: Contract) {
    super(contract);
  }
}

export function createContractEncoder(
  contract: Contract,
  version: ContractVersion
): ContractCallEncoder {
  switch (version) {
    case "v2":
      return new V2Encoder(contract);
    case "v1":
    default:
      return new V1Encoder(contract);
  }
}
