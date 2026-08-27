/**
 * Browser wallet adapters — separate entry point so server-side consumers
 * (Node scripts, auto-claim daemons, etc.) can import from `@sorostream/sdk`
 * without bundling browser-only `@stellar/freighter-api` code.
 *
 * @example
 * // Browser / frontend
 * import { createFreighterAdapter, connectWallet } from "@sorostream/sdk/wallets";
 *
 * // Node / server (no browser code pulled in)
 * import { SoroStreamClient } from "@sorostream/sdk";
 */
export { createFreighterAdapter, connectWallet, createMultisigAdapter, createClaimDelegateAdapter, KmsWalletAdapter, createKmsWalletAdapter, createKmsAdapter, } from './wallet.js';
export type { ClaimDelegateConfig } from './wallet.js';
export type { KmsWalletAdapterConfig } from './types.js';
