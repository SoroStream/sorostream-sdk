/**
 * Issue #887: guard against re-export drift between wallet.ts and the
 * browser-only `wallets.ts` entry point.
 */
import { describe, it, expect } from 'vitest';
import * as wallets from '../src/wallets.js';

const EXPECTED_EXPORTS = [
  'createFreighterAdapter',
  'connectWallet',
  'createMultisigAdapter',
  'createClaimDelegateAdapter',
  'KmsWalletAdapter',
  'createKmsWalletAdapter',
  'createKmsAdapter',
  'createWalletConnectV2Adapter',
  'createXDEFIAdapter',
  'AlbedoWalletAdapter',
  'createAlbedoWalletAdapter',
  'createAlbedoAdapter',
  'LobstrWalletAdapter',
  'createLobstrWalletAdapter',
  'createLobstrAdapter',
  'LedgerWalletAdapter',
  'createLedgerWalletAdapter',
  'createLedgerAdapter',
  'createHardwareWalletAdapter',
] as const;

describe('src/wallets.ts entry point', () => {
  it.each(EXPECTED_EXPORTS)('re-exports %s as a callable', (name) => {
    expect(typeof (wallets as Record<string, unknown>)[name]).toBe('function');
  });

  it('exposes exactly the documented runtime surface', () => {
    expect(Object.keys(wallets).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });
});
