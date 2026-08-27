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
import { nativeToScVal, Address, xdr } from '@stellar/stellar-sdk';

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
