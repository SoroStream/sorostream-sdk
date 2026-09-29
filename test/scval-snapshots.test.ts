/**
 * Issue #100 – Snapshot tests for ScVal serialisation round-trips.
 *
 * Tests the `nativeToScVal` helpers that the SDK uses to encode contract
 * call arguments. Each test serialises a representative value to XDR
 * (via toXDR("base64")) and matches the committed snapshot, so any silent
 * regression in the stellar-sdk serialisation layer is caught automatically.
 *
 * ScVal types covered: address, u64, u128 (i128), symbol, bool, map.
 */

import { describe, it, expect } from 'vitest';
import { nativeToScVal, Address, Contract, xdr } from '@stellar/stellar-sdk';
import {
  createContractEncoder,
  encodeAddress,
  encodeBytes,
  encodeI128,
  encodeString,
} from '../src/contractEncoders.js';

const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

function toBase64(scVal: xdr.ScVal): string {
  return scVal.toXDR('base64');
}

describe('ScVal serialisation snapshots', () => {
  it('address (account) serialises consistently', () => {
    const val = nativeToScVal(VALID_ACCOUNT, { type: 'address' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('address (contract) serialises consistently', () => {
    const val = nativeToScVal(VALID_CONTRACT, { type: 'address' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('u64 serialises consistently', () => {
    const val = nativeToScVal(42n, { type: 'u64' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('u64 large value serialises consistently', () => {
    const val = nativeToScVal(9_007_199_254_740_991n, { type: 'u64' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('u128 serialises consistently', () => {
    const val = nativeToScVal(1_000_000_000n, { type: 'u128' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('i128 serialises consistently', () => {
    const val = nativeToScVal(1_000_000_000n, { type: 'i128' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('symbol serialises consistently', () => {
    const val = nativeToScVal('create_stream', { type: 'symbol' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('bool true serialises consistently', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('bool false serialises consistently', () => {
    const val = nativeToScVal(false, { type: 'bool' });
    expect(toBase64(val)).toMatchSnapshot();
  });

  it('map (stream-like object) serialises consistently', () => {
    const val = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal('amount', { type: 'symbol' }),
        val: nativeToScVal(1_000_000_000n, { type: 'i128' }),
      }),
      new xdr.ScMapEntry({
        key: nativeToScVal('duration', { type: 'symbol' }),
        val: nativeToScVal(3600n, { type: 'u64' }),
      }),
    ]);
    expect(toBase64(val)).toMatchSnapshot();
  });
});

// ── Issue #587: snapshots for every public ScVal encoder output ──────────────

describe('contract encoder snapshots (#587)', () => {
  const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
  const encoders = {
    v1: createContractEncoder(new Contract(VALID_CONTRACT), 'v1'),
    v2: createContractEncoder(new Contract(VALID_CONTRACT), 'v2'),
  };

  it('primitive encoders serialise consistently', () => {
    expect({
      encodeAddressAccount: toBase64(encodeAddress(VALID_ACCOUNT)),
      encodeAddressContract: toBase64(encodeAddress(VALID_CONTRACT)),
      encodeI128Max: toBase64(encodeI128(2n ** 127n - 1n)),
      encodeI128Min: toBase64(encodeI128(-(2n ** 127n))),
      encodeI128Zero: toBase64(encodeI128(0n)),
      encodeBytes: toBase64(encodeBytes(new Uint8Array([0, 1, 2, 255]))),
      encodeBytesEmpty: toBase64(encodeBytes(new Uint8Array())),
      encodeString: toBase64(encodeString('sorostream 🚀')),
      encodeStringEmpty: toBase64(encodeString('')),
    }).toMatchSnapshot();
  });

  for (const [version, enc] of Object.entries(encoders)) {
    it(`${version} contract call operations serialise consistently`, () => {
      const ops: Record<string, xdr.Operation> = {
        createStream: enc.createStream(VALID_ACCOUNT, {
          recipient: RECIPIENT,
          token: VALID_CONTRACT,
          amount: 1_000_000_000n,
          durationSeconds: 86_400,
          autoRenew: false,
          namespace: 'payroll',
        }),
        withdraw: enc.withdraw('42', RECIPIENT),
        cancelStream: enc.cancelStream('42', VALID_ACCOUNT),
        topUp: enc.topUp('42', VALID_ACCOUNT, 500n),
        updateFlowRate: enc.updateFlowRate('42', VALID_ACCOUNT, 7n),
        setOperator: enc.setOperator('42', VALID_ACCOUNT, RECIPIENT, true),
        operatorCancelStream: enc.operatorCancelStream('42', RECIPIENT),
        operatorTopUp: enc.operatorTopUp('42', RECIPIENT, 500n),
        splitStream: enc.splitStream(VALID_ACCOUNT, {
          streamId: '42',
          ratioNumerator: 1,
          ratioDenominator: 3,
          recipientA: RECIPIENT,
          recipientB: VALID_ACCOUNT,
        }),
        transferStream: enc.transferStream('42', VALID_ACCOUNT, RECIPIENT),
        pauseStream: enc.pauseStream('42', VALID_ACCOUNT),
        resumeStream: enc.resumeStream('42', VALID_ACCOUNT),
        addDelegate: enc.addDelegate(VALID_ACCOUNT, RECIPIENT),
        revokeDelegate: enc.revokeDelegate(VALID_ACCOUNT, RECIPIENT),
        lockStream: enc.lockStream('42', VALID_ACCOUNT, 1_900_000_000),
      };
      expect(
        Object.fromEntries(Object.entries(ops).map(([k, op]) => [k, op.toXDR('base64')])),
      ).toMatchSnapshot();
    });
  }
});
