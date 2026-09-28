import { Address, Contract, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { ContractVersion, CreateStreamParams, SplitStreamParams } from './types.js';
import { isValidStellarAddress, parseStreamId } from './utils.js';
import { InvalidAddressError } from './errors.js';

// Issue #458: sanitise caller-supplied strings at the boundary before they
// are interpolated into a contract call, so malformed input is rejected
// with a clear SDK error instead of a raw parsing exception or an opaque
// on-chain rejection.
function requireAddress(address: string): string {
  if (!isValidStellarAddress(address)) {
    throw new InvalidAddressError(address);
  }
  return address;
}

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
  addDelegate(delegator: string, delegate: string): xdr.Operation;
  revokeDelegate(delegator: string, delegate: string): xdr.Operation;
  lockStream(streamId: string, sender: string, lockUntil: number): xdr.Operation;
}

class V1Encoder implements ContractCallEncoder {
  constructor(private contract: Contract) {}

  createStream(sender: string, params: CreateStreamParams): xdr.Operation {
    // Issue #341: Include namespace/metadata in the contract call.
    // Use nativeToScVal with type "string" which encodes as UTF-8,
    // ensuring non-ASCII characters (emoji, accented chars) survive
    // the XDR round-trip. Empty/undefined namespace is sent as empty string.
    const namespace = params.namespace ?? '';
    if (namespace.length > 256) {
      console.warn(
        '[SoroStream SDK] createStream: metadata/namespace exceeds 256 characters, ' +
          'it may be truncated by the contract.',
      );
    }
    return this.contract.call(
      'create_stream',
      nativeToScVal(sender, { type: 'address' }),
      nativeToScVal(params.recipient, { type: 'address' }),
      nativeToScVal(params.token, { type: 'address' }),
      nativeToScVal(params.amount, { type: 'i128' }),
      nativeToScVal(params.durationSeconds, { type: 'u64' }),
      nativeToScVal(params.autoRenew, { type: 'bool' }),
      nativeToScVal(namespace, { type: 'string' }), // Issue #341: UTF-8 encoded metadata
    );
  }

  withdraw(streamId: string, recipient: string): xdr.Operation {
    return this.contract.call(
      'withdraw',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(recipient), { type: 'address' }),
    );
  }

  cancelStream(streamId: string, sender: string): xdr.Operation {
    return this.contract.call(
      'cancel_stream',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
    );
  }

  topUp(streamId: string, sender: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      'top_up',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    );
  }

  updateFlowRate(streamId: string, sender: string, newFlowRate: bigint): xdr.Operation {
    return this.contract.call(
      'update_flow_rate',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
      nativeToScVal(newFlowRate, { type: 'i128' }),
    );
  }

  setOperator(
    streamId: string,
    sender: string,
    operator: string,
    approved: boolean,
  ): xdr.Operation {
    return this.contract.call(
      'set_operator',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
      nativeToScVal(requireAddress(operator), { type: 'address' }),
      nativeToScVal(approved, { type: 'bool' }),
    );
  }

  operatorCancelStream(streamId: string, operator: string): xdr.Operation {
    return this.contract.call(
      'operator_cancel_stream',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(operator), { type: 'address' }),
    );
  }

  operatorTopUp(streamId: string, operator: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      'operator_top_up',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(operator), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    );
  }

  splitStream(sender: string, params: SplitStreamParams): xdr.Operation {
    return this.contract.call(
      'split_stream',
      nativeToScVal(parseStreamId(params.streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
      nativeToScVal(params.ratioNumerator, { type: 'u64' }),
      nativeToScVal(params.ratioDenominator, { type: 'u64' }),
      nativeToScVal(requireAddress(params.recipientA), { type: 'address' }),
      nativeToScVal(requireAddress(params.recipientB), { type: 'address' }),
    );
  }

  transferStream(streamId: string, sender: string, newRecipient: string): xdr.Operation {
    return this.contract.call(
      'transfer_stream',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
      nativeToScVal(requireAddress(newRecipient), { type: 'address' }),
    );
  }

  pauseStream(streamId: string, sender: string): xdr.Operation {
    return this.contract.call(
      'pause_stream',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
    );
  }

  resumeStream(streamId: string, sender: string): xdr.Operation {
    return this.contract.call(
      'resume_stream',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
    );
  }

  addDelegate(delegator: string, delegate: string): xdr.Operation {
    return this.contract.call(
      'add_delegate',
      nativeToScVal(requireAddress(delegator), { type: 'address' }),
      nativeToScVal(requireAddress(delegate), { type: 'address' }),
    );
  }

  revokeDelegate(delegator: string, delegate: string): xdr.Operation {
    return this.contract.call(
      'revoke_delegate',
      nativeToScVal(requireAddress(delegator), { type: 'address' }),
      nativeToScVal(requireAddress(delegate), { type: 'address' }),
    );
  }

  lockStream(streamId: string, sender: string, lockUntil: number): xdr.Operation {
    return this.contract.call(
      'lock_until',
      nativeToScVal(parseStreamId(streamId), { type: 'u64' }),
      nativeToScVal(requireAddress(sender), { type: 'address' }),
      nativeToScVal(lockUntil, { type: 'u64' }),
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
  version: ContractVersion,
): ContractCallEncoder {
  switch (version) {
    case 'v2':
      return new V2Encoder(contract);
    case 'v1':
    default:
      return new V1Encoder(contract);
  }
}

// Issue #588: primitive ScVal encoders/decoders used for contract call
// arguments, exposed so their round-trip behaviour can be property-tested.

const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;

/** Encodes a Stellar account (G…) or contract (C…) address as an `ScVal`. */
export function encodeAddress(address: string): xdr.ScVal {
  return nativeToScVal(requireAddress(address), { type: 'address' });
}

/** Encodes a signed 128-bit integer as an `ScVal`. Throws `RangeError` outside the i128 range. */
export function encodeI128(value: bigint): xdr.ScVal {
  if (value < I128_MIN || value > I128_MAX) {
    throw new RangeError(`Value ${value} is outside the i128 range`);
  }
  return nativeToScVal(value, { type: 'i128' });
}

/** Encodes raw bytes as an `ScVal`. */
export function encodeBytes(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

/** Encodes a UTF-8 string as an `ScVal`. */
export function encodeString(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: 'string' });
}

/** Decodes an address `ScVal` produced by {@link encodeAddress}. */
export function decodeAddress(scVal: xdr.ScVal): string {
  return Address.fromScVal(scVal).toString();
}

/** Decodes an i128 `ScVal` produced by {@link encodeI128}. */
export function decodeI128(scVal: xdr.ScVal): bigint {
  return BigInt(scValToNative(scVal) as bigint);
}

/** Decodes a bytes `ScVal` produced by {@link encodeBytes}. */
export function decodeBytes(scVal: xdr.ScVal): Uint8Array {
  return new Uint8Array(scVal.bytes());
}

/** Decodes a string `ScVal` produced by {@link encodeString}. */
export function decodeString(scVal: xdr.ScVal): string {
  return scVal.str().toString();
}
