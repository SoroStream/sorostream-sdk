/**
 * Structured clone support for SDK stream objects across workers (issue #210).
 *
 * Stream objects contain BigInt fields that require custom serialization
 * to work with the structured clone algorithm and Web Workers.
 */

import { Account, Contract, Memo, Networks, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import type { BuildUnsignedXdrParams, Network, Stream } from './types.js';
import { createContractEncoder } from './contractEncoders.js';

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

const BASE_FEE = '100';

/**
 * Serialized representation of a Stream with BigInt fields converted to strings.
 * This format is structured-cloneable and can be passed to Web Workers.
 */
export interface SerializedStream {
  id: string;
  sender: string;
  recipient: string;
  token: string;
  /** deposit as a string to preserve precision */
  deposit: string;
  /** flowRate as a string to preserve precision */
  flowRate: string;
  startTime: number;
  endTime: number;
  lastWithdrawTime: number;
  status: 'Active' | 'Cancelled' | 'Completed' | 'Paused';
  autoRenew: boolean;
  pausedAt?: number;
  lockUntil?: number;
}

/**
 * Converts a Stream object to a structured-cloneable format.
 * BigInt fields are converted to strings to preserve precision.
 *
 * @param stream - The stream object to serialize
 * @returns A SerializedStream that can be passed through structuredClone()
 *
 * @example
 * ```ts
 * const stream = await client.getStream(streamId);
 * const serialized = serializeStream(stream);
 * // Send to worker
 * worker.postMessage({ type: 'PROCESS_STREAM', stream: serialized });
 * ```
 */
export function serializeStream(stream: Stream): SerializedStream {
  return {
    id: stream.id,
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    deposit: stream.deposit.toString(),
    flowRate: stream.flowRate.toString(),
    startTime: stream.startTime,
    endTime: stream.endTime,
    lastWithdrawTime: stream.lastWithdrawTime,
    status: stream.status,
    autoRenew: stream.autoRenew,
    ...(stream.pausedAt !== undefined ? { pausedAt: stream.pausedAt } : {}),
    ...(stream.lockUntil !== undefined ? { lockUntil: stream.lockUntil } : {}),
  };
}

/**
 * Converts a SerializedStream back to a Stream object.
 * String BigInt fields are converted back to bigint primitives.
 *
 * @param data - The serialized stream data
 * @returns A Stream object with proper types restored
 *
 * @example
 * ```ts
 * // In worker context
 * self.onmessage = (e) => {
 *   const stream = deserializeStream(e.data.stream);
 *   // Use stream with full bigint support
 *   const claimable = stream.flowRate * BigInt(Date.now() - stream.lastWithdrawTime);
 * };
 * ```
 */
export function deserializeStream(data: SerializedStream): Stream {
  return {
    id: data.id,
    sender: data.sender,
    recipient: data.recipient,
    token: data.token,
    deposit: BigInt(data.deposit),
    flowRate: BigInt(data.flowRate),
    startTime: data.startTime,
    endTime: data.endTime,
    lastWithdrawTime: data.lastWithdrawTime,
    status: data.status,
    autoRenew: data.autoRenew,
    ...(data.pausedAt !== undefined ? { pausedAt: data.pausedAt } : {}),
    ...(data.lockUntil !== undefined ? { lockUntil: data.lockUntil } : {}),
  };
}

/**
 * Constructs and serialises a Soroban contract transaction to unsigned XDR
 * without broadcasting it, enabling air-gapped or server-side signing workflows (issue #438).
 *
 * @param operation - The contract operation (an xdr.Operation or method name string).
 * @param params - Parameters containing sourceAccount, contractId, network, and operation arguments.
 * @returns Base64 encoded unsigned transaction XDR string.
 */
export function buildUnsignedXdr(
  operation: xdr.Operation | string,
  params: BuildUnsignedXdrParams,
): string {
  const sourceAddress =
    typeof params.sourceAccount === 'string'
      ? params.sourceAccount
      : params.sourceAccount.accountId();

  const account =
    typeof params.sourceAccount === 'string'
      ? new Account(params.sourceAccount, String(params.sequenceNumber ?? '0'))
      : params.sourceAccount;

  const networkPassphrase =
    params.networkPassphrase ??
    (params.network && params.network in NETWORK_PASSPHRASES
      ? NETWORK_PASSPHRASES[params.network as Network]
      : undefined) ??
    Networks.TESTNET;

  let op: xdr.Operation;
  if (typeof operation === 'string') {
    if (!params.contractId) {
      throw new Error('contractId is required when operation is specified as a string');
    }
    const contract = new Contract(params.contractId);
    const encoder = createContractEncoder(contract, params.contractVersion ?? 'v1');
    const sender = params.sender ?? sourceAddress;

    switch (operation) {
      case 'createStream':
        op = encoder.createStream(sender, {
          recipient: params.recipient!,
          token: params.token!,
          amount: typeof params.amount === 'bigint' ? params.amount : BigInt(params.amount ?? 0),
          durationSeconds: Number(params.durationSeconds ?? 0),
          startTime: params.startTime,
          cliffSeconds: params.cliffSeconds,
          autoRenew: params.autoRenew ?? false,
          namespace: params.namespace,
        });
        break;
      case 'withdraw':
        op = encoder.withdraw(String(params.streamId ?? ''), params.recipient ?? sender);
        break;
      case 'cancelStream':
        op = encoder.cancelStream(String(params.streamId ?? ''), sender);
        break;
      case 'topUp':
        op = encoder.topUp(
          String(params.streamId ?? ''),
          sender,
          typeof params.amount === 'bigint' ? params.amount : BigInt(params.amount ?? 0),
        );
        break;
      case 'updateFlowRate':
        op = encoder.updateFlowRate(
          String(params.streamId ?? ''),
          sender,
          typeof params.newFlowRate === 'bigint'
            ? params.newFlowRate
            : BigInt(params.newFlowRate ?? 0),
        );
        break;
      case 'pauseStream':
        op = encoder.pauseStream(String(params.streamId ?? ''), sender);
        break;
      case 'resumeStream':
        op = encoder.resumeStream(String(params.streamId ?? ''), sender);
        break;
      case 'transferStream':
        op = encoder.transferStream(String(params.streamId ?? ''), sender, params.newRecipient!);
        break;
      case 'setOperator':
        op = encoder.setOperator(
          String(params.streamId ?? ''),
          sender,
          params.operator!,
          Boolean(params.approved),
        );
        break;
      case 'operatorCancelStream':
        op = encoder.operatorCancelStream(String(params.streamId ?? ''), params.operator ?? sender);
        break;
      case 'operatorTopUp':
        op = encoder.operatorTopUp(
          String(params.streamId ?? ''),
          params.operator ?? sender,
          typeof params.amount === 'bigint' ? params.amount : BigInt(params.amount ?? 0),
        );
        break;
      case 'addDelegate':
        op = encoder.addDelegate(params.delegator ?? sender, params.delegate!);
        break;
      case 'revokeDelegate':
        op = encoder.revokeDelegate(params.delegator ?? sender, params.delegate!);
        break;
      default:
        throw new Error(`Unsupported operation name: ${operation}`);
    }
  } else {
    op = operation;
  }

  let builder = new TransactionBuilder(account, {
    fee: String(params.fee ?? BASE_FEE),
    networkPassphrase,
  });

  if (params.memo) {
    builder = builder.addMemo(Memo.text(params.memo));
  }

  builder = builder.addOperation(op);
  const tx = builder.setTimeout(params.timeout ?? 30).build();
  return tx.toXDR();
}
