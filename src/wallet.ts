import { Keypair, TransactionBuilder, xdr, hash, nativeToScVal } from '@stellar/stellar-sdk';
import { WalletConnectSessionExpiredError } from './errors.js';
import type {
  WalletAdapter,
  Network,
  MultisigSigner,
  PasskeyAdapterConfig,
  KmsWalletAdapterConfig,
  LobstrWalletAdapterConfig,
  LedgerWalletAdapterConfig,
} from './types.js';

/**
 * Configuration for a claim-delegation adapter.
 *
 * The pattern lets an automated "claim bot" key call `withdraw` on behalf of the
 * recipient without ever holding the recipient's primary key:
 *
 * 1. On-chain: add the bot key as a co-signer on the recipient's Stellar account
 *    with a weight that meets the low-security threshold (e.g. weight 1 on a 1-of-N
 *    multisig). The primary key retains sole control over high-security operations.
 * 2. In the SDK: pass the recipient address as `recipientAddress` and the bot's
 *    {@link MultisigSigner} as `claimBotSigner`.
 *
 * The resulting adapter always presents `recipientAddress` to `getPublicKey()`
 * (so `withdraw` receives the correct recipient auth), but the transaction envelope
 * is signed exclusively by the claim bot key.
 *
 * @example
 * ```ts
 * // Bot key loaded from env â€” never has custody of the recipient address.
 * const botSigner: MultisigSigner = {
 *   async signTransaction(xdr, network) {
 *     const kp = Keypair.fromSecret(process.env.CLAIM_BOT_SECRET!);
 *     const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
 *     tx.sign(kp);
 *     return tx.toEnvelope().toXDR("base64");
 *   },
 * };
 *
 * const adapter = createClaimDelegateAdapter({
 *   recipientAddress: "GRECIPI...",
 *   claimBotSigner: botSigner,
 * });
 *
 * const client = new SoroStreamClient({ network: "testnet", contractId, walletAdapter: adapter });
 * await client.withdraw({ streamId });
 * ```
 */
export interface ClaimDelegateConfig {
  /** The actual recipient address (passed to `require_auth` on-chain). */
  recipientAddress: string;
  /** A signer representing the claim bot key. */
  claimBotSigner: MultisigSigner;
}

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

/** Maps Freighter's network identifiers to the SDK's {@link Network} type. */
const FREIGHTER_NETWORK_MAP: Record<string, Network> = {
  PUBLIC: 'mainnet',
  TESTNET: 'testnet',
  FUTURENET: 'futurenet',
};

/**
 * Creates a WalletAdapter backed by the Freighter browser extension.
 * Dynamically imports @stellar/freighter-api to avoid SSR issues.
 *
 * @example
 * ```ts
 * import { SoroStreamClient, createFreighterAdapter } from "@sorostream/sdk";
 *
 * const freighterAdapter = await createFreighterAdapter();
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "YOUR_CONTRACT_ID",
 *   walletAdapter: freighterAdapter,
 * });
 * ```
 */
type FreighterWatchPayload = {
  network?: string;
  address?: string;
  error?: { message: string };
};

type FreighterModule = {
  isConnected: () => Promise<{ isConnected: boolean }>;
  getAddress: () => Promise<{ address: string; error?: { message: string } }>;
  signTransaction: (
    xdr: string,
    opts: { networkPassphrase: string },
  ) => Promise<{ signedTxXdr: string; error?: { message: string } }>;
  requestAccess?: () => Promise<{ error?: { message: string } }>;
  WatchWalletChanges: new () => {
    watch: (cb: (payload: FreighterWatchPayload) => void) => void;
    stop: () => void;
  };
};

export async function createFreighterAdapter(): Promise<WalletAdapter> {
  const freighter = (await import('@stellar/freighter-api')) as unknown as FreighterModule;

  let lastNetwork: string | null = null;
  /** Empty/missing address after a prior successful read means Freighter is locked. */
  let lastAddress: string | null = null;
  let locked = false;
  const networkListeners = new Set<(network: Network) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  let watcher: { stop: () => void } | null = null;

  function emitConnection(connected: boolean): void {
    for (const cb of connectionListeners) cb(connected);
  }

  function setLocked(next: boolean): void {
    if (locked === next) return;
    locked = next;
    emitConnection(!next);
  }

  function ensureWatcher(): void {
    if (watcher) return;
    const w = new freighter.WatchWalletChanges();
    w.watch((payload) => {
      if (payload.error) {
        setLocked(true);
        return;
      }

      // Issue #410: treat an empty address as a lock; a restored address is an unlock.
      if (payload.address !== undefined) {
        const nextLocked = payload.address.length === 0;
        lastAddress = nextLocked ? null : payload.address;
        setLocked(nextLocked);
      }

      if (!payload.network) return;
      if (lastNetwork === null) {
        lastNetwork = payload.network;
        return;
      }
      if (payload.network === lastNetwork) return;
      lastNetwork = payload.network;

      const mapped = FREIGHTER_NETWORK_MAP[payload.network];
      if (mapped) {
        for (const cb of networkListeners) cb(mapped);
      }
    });
    watcher = w;
  }

  function maybeStopWatcher(): void {
    if (networkListeners.size > 0 || connectionListeners.size > 0) return;
    watcher?.stop();
    watcher = null;
    lastNetwork = null;
  }

  async function requestAccessIfNeeded(): Promise<void> {
    if (typeof freighter.requestAccess !== 'function') return;
    const access = await freighter.requestAccess();
    if (access?.error) {
      throw new Error(access.error.message);
    }
  }

  /**
   * Re-establishes a Freighter session after lock/unlock (issue #410).
   * `isConnected()` on Freighter only reports whether the extension is
   * installed, so we also re-read the address and call `requestAccess`
   * when the previous session was locked or the address lookup fails.
   */
  async function ensureSession(): Promise<void> {
    ensureWatcher();
    const installed = await freighter.isConnected();
    if (!installed.isConnected || locked || !lastAddress) {
      await requestAccessIfNeeded();
    }

    const result = await freighter.getAddress();
    if (result.error || !result.address) {
      await requestAccessIfNeeded();
      const retry = await freighter.getAddress();
      if (retry.error || !retry.address) {
        setLocked(true);
        throw new Error(
          retry.error?.message ?? result.error?.message ?? 'Freighter wallet is not connected',
        );
      }
      lastAddress = retry.address;
      setLocked(false);
      return;
    }

    lastAddress = result.address;
    setLocked(false);
  }

  return {
    async isConnected(): Promise<boolean> {
      const result = await freighter.isConnected();
      if (!result.isConnected) return false;
      return !locked;
    },

    async getPublicKey(): Promise<string> {
      await ensureSession();
      const result = await freighter.getAddress();
      if (result.error) throw new Error(result.error.message);
      return result.address;
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      await ensureSession();
      const result = await freighter.signTransaction(xdrStr, {
        networkPassphrase: NETWORK_PASSPHRASES[network],
      });
      if (result.error) throw new Error(result.error.message);
      return result.signedTxXdr;
    },

    /**
     * Subscribes to Freighter's network-change polling (issue #215).
     * Freighter has no push event for network switches, so this wraps
     * `WatchWalletChanges`, which polls `getNetworkDetails()` and reports
     * whenever the network differs from the last observed value. The first
     * poll only seeds the baseline and does not fire `callback`.
     */
    onNetworkChange(callback: (network: Network) => void): () => void {
      ensureWatcher();
      networkListeners.add(callback);
      return () => {
        networkListeners.delete(callback);
        maybeStopWatcher();
      };
    },

    /**
     * Subscribes to Freighter lock/unlock (issue #410).
     */
    onConnectionChange(callback: (connected: boolean) => void): () => void {
      ensureWatcher();
      connectionListeners.add(callback);
      return () => {
        connectionListeners.delete(callback);
        maybeStopWatcher();
      };
    },
  };
}

/**
 * Zeroes out a `Keypair`'s raw secret key buffers (issue #460). `Keypair`
 * does not expose a way to do this itself, so this reaches into its
 * internal `_secretSeed`/`_secretKey` buffers directly. Uses `.fill(0)`
 * (a standard TypedArray method) rather than any Node `Buffer` API, so it
 * works in browser/Workers environments too.
 */
function zeroKeypairSecret(keypair: Keypair): void {
  const internal = keypair as unknown as {
    _secretSeed?: Uint8Array;
    _secretKey?: Uint8Array;
  };
  internal._secretSeed?.fill(0);
  internal._secretKey?.fill(0);
}

/**
 * Creates a server-side WalletAdapter that signs directly with a Stellar Keypair.
 * Suitable for Node.js scripts, backends, and automated payouts.
 *
 * A fresh `Keypair` is derived from `secretKey` for each `signTransaction`
 * call and its raw key buffers are zeroed immediately afterward (issue
 * #460), so they aren't retained in memory longer than the signing
 * operation itself. `getPublicKey` never needs the secret at all — the
 * public key is derived once at creation and cached. Note that `secretKey`
 * itself is a JS string, which cannot be zeroed in place; call `destroy()`
 * to drop this adapter's reference to it once you're done with the adapter.
 *
 * @param secretKey - The Stellar secret key (base-32 encoded seed starting with "S").
 *
 * @example
 * ```ts
 * import { SoroStreamClient, createKeypairAdapter } from "@sorostream/sdk";
 *
 * const serverKeypairAdapter = createKeypairAdapter(process.env.STELLAR_SECRET!);
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "YOUR_CONTRACT_ID",
 *   walletAdapter: serverKeypairAdapter,
 * });
 * ```
 */
export function createKeypairAdapter(secretKey: string): WalletAdapter {
  const initialKeypair = Keypair.fromSecret(secretKey);
  const publicKey = initialKeypair.publicKey();
  zeroKeypairSecret(initialKeypair);

  let secret: string | null = secretKey;
  let destroyed = false;

  return {
    async isConnected(): Promise<boolean> {
      return !destroyed;
    },

    async getPublicKey(): Promise<string> {
      return publicKey;
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      if (destroyed || secret === null) {
        throw new Error('createKeypairAdapter: cannot sign, adapter has been destroyed');
      }
      const keypair = Keypair.fromSecret(secret);
      try {
        const tx = TransactionBuilder.fromXDR(xdrStr, NETWORK_PASSPHRASES[network]);
        tx.sign(keypair);
        return tx.toEnvelope().toXDR('base64');
      } finally {
        zeroKeypairSecret(keypair);
      }
    },

    destroy(): void {
      secret = null;
      destroyed = true;
    },
  };
}

/**
 * Prompts the user to connect their Freighter wallet.
 * Throws if Freighter is not installed or the user rejects.
 */
export async function connectWallet(): Promise<string> {
  const freighter = await import('@stellar/freighter-api');
  const connected = await freighter.isConnected();
  if (!connected.isConnected) {
    throw new Error('Freighter extension is not installed');
  }
  const result = await freighter.getAddress();
  if (result.error) throw new Error(result.error.message);
  return result.address;
}

/**
 * Creates a {@link WalletAdapter} that presents the recipient's address to the
 * contract but signs transactions with a separate claim-bot key.
 *
 * The bot key must be a co-signer on the recipient's Stellar account (classic
 * multisig) so that Soroban's `require_auth` accepts its signature for `withdraw`.
 *
 * This enables automated claiming daemons that never hold the recipient's primary
 * secret key. See {@link ClaimDelegateConfig} for the full setup guide.
 */
export function createClaimDelegateAdapter(config: ClaimDelegateConfig): WalletAdapter {
  return {
    async isConnected(): Promise<boolean> {
      return true;
    },

    async getPublicKey(): Promise<string> {
      return config.recipientAddress;
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      return config.claimBotSigner.signTransaction(xdr, network);
    },
  };
}

/**
 * Creates a WalletAdapter for a multi-sig Stellar account.
 *
 * The adapter collects signatures from each signer and combines them into
 * a single transaction envelope before submission.
 *
 * @param config.address - The multisig source account address.
 * @param config.signers - Array of signers that each independently sign the tx.
 * @param config.threshold - Optional minimum number of signatures required
 *   (defaults to `signers.length`, i.e. all must sign).
 */
export async function createMultisigAdapter(config: {
  address: string;
  signers: MultisigSigner[];
  threshold?: number;
}): Promise<WalletAdapter> {
  const threshold = config.threshold ?? config.signers.length;

  return {
    async isConnected(): Promise<boolean> {
      return true;
    },

    async getPublicKey(): Promise<string> {
      return config.address;
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      const passphrase = NETWORK_PASSPHRASES[network];

      let combined: ReturnType<typeof TransactionBuilder.fromXDR> | null = null;
      let collected = 0;
      const seen = new Set<string>();

      for (const signer of config.signers) {
        if (collected >= threshold) break;

        const signedXdr = await signer.signTransaction(xdrStr, network);
        const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);

        for (const sig of tx.signatures) {
          const key = sig.hint().toString('base64') + sig.signature().toString('base64');
          if (!seen.has(key)) {
            seen.add(key);
            if (!combined) {
              combined = TransactionBuilder.fromXDR(xdrStr, passphrase);
            }
            combined.signatures.push(sig);
            collected++;
          }
        }
      }

      if (!combined) {
        throw new Error('No signatures were collected');
      }

      return combined.toEnvelope().toXDR('base64');
    },
  };
}

// â”€â”€ Issue #46: WebAuthn passkey adapter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Converts a DER-encoded P-256 ECDSA signature to compact (r || s) form.
 * DER format: 0x30 <total-len> 0x02 <r-len> <r> 0x02 <s-len> <s>
 */
function derToCompact(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('Invalid DER signature: expected 0x30');
  offset++; // skip total length byte
  if (der[offset++] !== 0x02) throw new Error('Invalid DER signature: expected 0x02 for r');
  const rLen = der[offset++];
  if (rLen === undefined) throw new Error('Invalid DER signature: truncated r length');
  const r = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset++] !== 0x02) throw new Error('Invalid DER signature: expected 0x02 for s');
  const sLen = der[offset++];
  if (sLen === undefined) throw new Error('Invalid DER signature: truncated s length');
  const s = der.slice(offset, offset + sLen);

  const compact = new Uint8Array(64);
  // r and s may have a leading 0x00 padding byte; trim and right-align to 32 bytes
  const rBytes = r[0] === 0 ? r.slice(1) : r;
  const sBytes = s[0] === 0 ? s.slice(1) : s;
  compact.set(rBytes, 32 - rBytes.length);
  compact.set(sBytes, 64 - sBytes.length);
  return compact;
}

/**
 * Creates a WalletAdapter for a Soroban smart-wallet contract that is
 * authenticated via WebAuthn/passkeys rather than a classic Ed25519 keypair.
 *
 * The adapter signs each `invokeHostFunction` auth entry by:
 *  1. Computing the Soroban contract-auth signing challenge (SHA-256 of the
 *     `HashIdPreimageSorobanAuthorization` XDR).
 *  2. Requesting a WebAuthn assertion from the registered passkey.
 *  3. Attaching the response (`authenticator_data`, `client_data_json`,
 *     compact `signature`) as a ScVal map in the auth entry credentials.
 *
 * This follows the Soroban Passkey Kit signature format expected by the
 * `__check_auth` function on standard Soroban smart wallet contracts.
 *
 * **Requirements:** Must be called in a browser environment with WebAuthn
 * support. The contract must already be deployed.
 *
 * @param config - Passkey adapter configuration.
 *
 * @example
 * ```ts
 * const adapter = await createPasskeyAdapter({
 *   contractId: "CA...",
 *   rpId: "myapp.example.com",
 *   credentialId: myCredentialIdArrayBuffer,
 * });
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter: adapter });
 * ```
 */
export async function createPasskeyAdapter(config: PasskeyAdapterConfig): Promise<WalletAdapter> {
  if (
    typeof window === 'undefined' ||
    !('credentials' in navigator) ||
    !('PublicKeyCredential' in window)
  ) {
    throw new Error('WebAuthn is not available in this environment');
  }

  return {
    async isConnected(): Promise<boolean> {
      return (
        typeof window !== 'undefined' &&
        'credentials' in navigator &&
        'PublicKeyCredential' in window
      );
    },

    async getPublicKey(): Promise<string> {
      return config.contractId;
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      const passphrase = NETWORK_PASSPHRASES[network];

      // Parse the raw transaction envelope so we can read and mutate auth entries
      const txEnvelope = xdr.TransactionEnvelope.fromXDR(xdrStr, 'base64');
      const v1Body = txEnvelope.v1().tx();
      let modified = false;

      for (const op of v1Body.operations()) {
        const body = op.body();
        if (body.switch().name !== 'invokeHostFunction') continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const invokeOp = (body as any).invokeHostFunction() as xdr.InvokeHostFunctionOp;
        const authArr = invokeOp.auth();

        for (let i = 0; i < authArr.length; i++) {
          const entry = authArr[i];
          if (!entry) continue;
          const creds = entry.credentials();
          if (creds.switch().name !== 'sorobanCredentialsAddress') continue;

          const addrCreds = creds.address();

          // Build the Soroban authorization signing preimage
          // (ENVELOPE_TYPE_SOROBAN_AUTHORIZATION)
          // Issue #406: use TextEncoder instead of Buffer.from so this code is
          // safe in Cloudflare Workers (no Node.js Buffer available).
          // The cast to Buffer satisfies Stellar SDK TypeScript types; at
          // runtime the SDK only needs a Uint8Array (Buffer is a subclass).
          const networkId = hash(new TextEncoder().encode(passphrase) as unknown as Buffer);
          const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new xdr.HashIdPreimageSorobanAuthorization({
              networkId,
              nonce: addrCreds.nonce(),
              signatureExpirationLedger: addrCreds.signatureExpirationLedger(),
              invocation: entry.rootInvocation(),
            }),
          );
          const challengeHash = hash(preimage.toXDR());
          // Convert to a plain Uint8Array backed by a fresh ArrayBuffer (required by WebAuthn API)
          const challenge = Uint8Array.from(challengeHash);

          // Request WebAuthn assertion using the signing challenge
          const assertion = (await navigator.credentials.get({
            publicKey: {
              challenge,
              rpId: config.rpId,
              allowCredentials: [{ type: 'public-key' as const, id: config.credentialId }],
              userVerification: 'required',
            },
          })) as PublicKeyCredential | null;

          if (!assertion) {
            throw new Error('WebAuthn: authentication was cancelled or failed');
          }

          const response = assertion.response as AuthenticatorAssertionResponse;
          const compactSig = derToCompact(new Uint8Array(response.signature));

          // Replace auth entry in-place with the WebAuthn credential.
          // Signature map format required by Soroban Passkey Kit __check_auth:
          //   { authenticator_data: Bytes, client_data_json: Bytes, signature: Bytes }
          authArr[i] = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
              new xdr.SorobanAddressCredentials({
                address: addrCreds.address(),
                nonce: addrCreds.nonce(),
                signatureExpirationLedger: addrCreds.signatureExpirationLedger(),
                signature: nativeToScVal({
                  authenticator_data: Buffer.from(response.authenticatorData),
                  client_data_json: Buffer.from(response.clientDataJSON),
                  signature: Buffer.from(compactSig),
                }),
              }),
            ),
            rootInvocation: entry.rootInvocation(),
          });

          modified = true;
        }
      }

      if (!modified) return xdrStr;

      return txEnvelope.toXDR('base64');
    },
  };
}

/**
 * WalletAdapter implementation that communicates with a Ledger hardware device via WebUSB or WebHID to sign Soroban transactions (issue #432).
 */
export class LedgerWalletAdapter implements WalletAdapter {
  private transport?: any;
  private bip32Path: string;
  private publicKey?: string;
  private transportType: 'webusb' | 'webhid' | 'custom';
  private networkListeners: Set<(network: Network) => void> = new Set();
  private connectionListeners: Set<(connected: boolean) => void> = new Set();

  constructor(config?: LedgerWalletAdapterConfig) {
    this.transport = config?.transport;
    this.bip32Path = config?.bip32Path ?? "44'/148'/0'";
    this.publicKey = config?.publicKey;
    this.transportType = config?.transportType ?? 'webusb';
  }

  private async getTransportInstance(): Promise<any> {
    if (this.transport) return this.transport;

    if (this.transportType === 'webhid') {
      // @ts-ignore
      const mod = await import('@ledgerhq/hw-transport-webhid').catch(() => null);
      if (!mod) throw new Error('WebHID transport (@ledgerhq/hw-transport-webhid) is not available');
      const TransportWebHID = (mod as any).default ?? mod;
      this.transport = await TransportWebHID.create();
    } else {
      // @ts-ignore
      const mod = await import('@ledgerhq/hw-transport-webusb').catch(() => null);
      if (!mod) throw new Error('WebUSB transport (@ledgerhq/hw-transport-webusb) is not available');
      const TransportWebUSB = (mod as any).default ?? mod;
      this.transport = await TransportWebUSB.create();
    }
    return this.transport;
  }

  private async getAppInstance(): Promise<any> {
    const transport = await this.getTransportInstance();
    const hwAppStr = await import('@ledgerhq/hw-app-str');
    const StrClass = (hwAppStr as any).default ?? hwAppStr;
    return new StrClass(transport);
  }

  async isConnected(): Promise<boolean> {
    try {
      if (this.transport) return true;
      if (typeof window !== 'undefined') {
        const nav = (window as any).navigator || (typeof navigator !== 'undefined' ? navigator : null);
        if (nav && ('usb' in nav || 'hid' in nav)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async getPublicKey(): Promise<string> {
    if (this.publicKey) return this.publicKey;
    try {
      const app = await this.getAppInstance();
      const result = await app.getPublicKey(this.bip32Path);
      const key = typeof result === 'string' ? result : (result.publicKey || result.address);
      if (!key) throw new Error('Failed to retrieve public key from Ledger device');
      this.publicKey = key;
      return key;
    } catch (err: any) {
      throw new Error(`Ledger getPublicKey failed: ${err?.message || err}`);
    }
  }

  async signTransaction(xdrStr: string, _network: Network): Promise<string> {
    try {
      const app = await this.getAppInstance();
      const txEnvelope = xdr.TransactionEnvelope.fromXDR(xdrStr, 'base64');
      const txHash = hash(txEnvelope.toXDR());

      let signature: Buffer;
      if (typeof app.signHash === 'function') {
        const res = await app.signHash(this.bip32Path, txHash);
        signature = res.signature ?? res;
      } else if (typeof app.signTransaction === 'function') {
        const res = await app.signTransaction(this.bip32Path, txHash);
        signature = res.signature ?? res;
      } else {
        throw new Error('Ledger app does not support transaction signing');
      }

      const pubKey = await this.getPublicKey();
      const kp = Keypair.fromPublicKey(pubKey);
      const decorated = new xdr.DecoratedSignature({
        hint: kp.signatureHint(),
        signature: Buffer.from(signature),
      });

      const v1 = txEnvelope.v1();
      v1.signatures().push(decorated);
      return txEnvelope.toXDR('base64');
    } catch (err: any) {
      throw new Error(`Ledger signTransaction failed: ${err?.message || err}`);
    }
  }

  onNetworkChange(callback: (network: Network) => void): () => void {
    this.networkListeners.add(callback);
    return () => this.networkListeners.delete(callback);
  }

  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this.connectionListeners.add(callback);
    return () => this.connectionListeners.delete(callback);
  }
}

/**
 * Creates a WalletAdapter backed by a Ledger hardware wallet (issue #432).
 */
export function createLedgerWalletAdapter(config?: LedgerWalletAdapterConfig): WalletAdapter {
  return new LedgerWalletAdapter(config);
}

/** Alias for createLedgerWalletAdapter. */
export function createLedgerAdapter(config: { transport?: unknown }): WalletAdapter {
  return new LedgerWalletAdapter(config);
}

/**
 * WalletAdapter implementation that delegates signing to an external KMS provider (issue #306).
 * Private key material never enters local memory or key storage.
 */
export class KmsWalletAdapter implements WalletAdapter {
  private readonly publicKey: string;
  private readonly signFn: (payload: Uint8Array) => Promise<Uint8Array>;

  constructor(config: KmsWalletAdapterConfig) {
    if (!config.publicKey) {
      throw new Error('KmsWalletAdapter requires a valid publicKey');
    }
    if (typeof config.sign !== 'function') {
      throw new Error('KmsWalletAdapter requires a sign function');
    }
    this.publicKey = config.publicKey;
    this.signFn = config.sign;
  }

  async isConnected(): Promise<boolean> {
    return true;
  }

  async getPublicKey(): Promise<string> {
    return this.publicKey;
  }

  async signTransaction(xdrStr: string, _network: Network): Promise<string> {
    const txEnvelope = xdr.TransactionEnvelope.fromXDR(xdrStr, 'base64');
    const txHash = hash(txEnvelope.toXDR());

    // Delegate signing to provided async KMS function
    const signatureBytes = await this.signFn(new Uint8Array(txHash));

    const kp = Keypair.fromPublicKey(this.publicKey);
    const decorated = new xdr.DecoratedSignature({
      hint: kp.signatureHint(),
      signature: Buffer.from(signatureBytes),
    });

    const v1 = txEnvelope.v1();
    v1.signatures().push(decorated);

    return txEnvelope.toXDR('base64');
  }
}

/**
 * Creates a WalletAdapter backed by a KMS key provider (issue #306).
 *
 * @example
 * ```ts
 * const adapter = createKmsWalletAdapter({
 *   publicKey: "G...",
 *   async sign(payload) {
 *     return await kmsClient.sign(payload);
 *   }
 * });
 * ```
 */
export function createKmsWalletAdapter(config: KmsWalletAdapterConfig): WalletAdapter {
  return new KmsWalletAdapter(config);
}

/** Alias for createKmsWalletAdapter. */
export const createKmsAdapter = createKmsWalletAdapter;

/**
 * WalletAdapter implementation for the Lobstr wallet (issue #431).
 * Supports both extension (`window.lobstr`) and mobile/custom provider instances.
 */
export class LobstrWalletAdapter implements WalletAdapter {
  private publicKey?: string;
  private provider?: any;
  private networkListeners: Set<(network: Network) => void> = new Set();
  private connectionListeners: Set<(connected: boolean) => void> = new Set();

  constructor(config?: LobstrWalletAdapterConfig) {
    this.publicKey = config?.publicKey;
    this.provider = config?.provider;
  }

  private getProvider(): any {
    if (this.provider) return this.provider;
    if (typeof window !== 'undefined' && (window as any).lobstr) {
      return (window as any).lobstr;
    }
    return null;
  }

  async isConnected(): Promise<boolean> {
    const provider = this.getProvider();
    if (!provider) return false;
    if (typeof provider.isConnected === 'function') {
      return await provider.isConnected();
    }
    return true;
  }

  async getPublicKey(): Promise<string> {
    if (this.publicKey) return this.publicKey;
    const provider = this.getProvider();
    if (!provider) {
      throw new Error('Lobstr wallet provider is not available');
    }
    if (typeof provider.getPublicKey === 'function') {
      const key = await provider.getPublicKey();
      if (typeof key === 'string' && key) {
        this.publicKey = key;
        return key;
      }
      if (key?.publicKey) {
        this.publicKey = key.publicKey;
        return key.publicKey;
      }
    }
    if (typeof provider.getAccount === 'function') {
      const acc = await provider.getAccount();
      const key = typeof acc === 'string' ? acc : acc?.address ?? acc?.publicKey;
      if (key) {
        this.publicKey = key;
        return key;
      }
    }
    throw new Error('Lobstr wallet provider did not return a valid public key');
  }

  async signTransaction(xdrStr: string, network: Network): Promise<string> {
    const provider = this.getProvider();
    if (!provider) {
      throw new Error('Lobstr wallet provider is not available');
    }
    const networkPassphrase = NETWORK_PASSPHRASES[network] ?? network;

    if (typeof provider.signTransaction === 'function') {
      const res = await provider.signTransaction(xdrStr, {
        networkPassphrase,
        network,
      });
      if (typeof res === 'string') return res;
      if (res?.signedTxXdr) return res.signedTxXdr;
      if (res?.xdr) return res.xdr;
    }
    if (typeof provider.sign === 'function') {
      const res = await provider.sign(xdrStr, { networkPassphrase });
      if (typeof res === 'string') return res;
      if (res?.signedTxXdr) return res.signedTxXdr;
    }
    throw new Error('Lobstr wallet failed to sign transaction');
  }

  onNetworkChange(callback: (network: Network) => void): () => void {
    this.networkListeners.add(callback);
    return () => this.networkListeners.delete(callback);
  }

  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this.connectionListeners.add(callback);
    return () => this.connectionListeners.delete(callback);
  }
}

/**
 * Creates a WalletAdapter backed by the Lobstr wallet (issue #431).
 */
export function createLobstrWalletAdapter(config?: LobstrWalletAdapterConfig): WalletAdapter {
  return new LobstrWalletAdapter(config);
}

/** Alias for createLobstrWalletAdapter. */
export const createLobstrAdapter = createLobstrWalletAdapter;

// ── Issue #367: WalletConnect v2 adapter ─────────────────────────────────────

/**
 * Configuration for the WalletConnect v2 adapter.
 */
export interface WalletConnectV2AdapterConfig {
  /** WalletConnect Cloud project ID (required for v2 protocol). */
  projectId: string;
  /** Optional relay URL. Defaults to WalletConnect's default relay. */
  relayUrl?: string;
  /** Optional metadata for the dapp (displayed in the wallet approval prompt). */
  metadata?: {
    name?: string;
    description?: string;
    url?: string;
    icons?: string[];
  };
  /** Optional chain ID to request (default: "stellar:pubnet" or "stellar:testnet"). */
  chainId?: string;
}

type WalletConnectSignClient = {
  init(config: unknown): Promise<void>;
  connect(params: {
    requiredNamespaces: Record<string, { methods: string[]; chains: string[]; events: string[] }>;
  }): Promise<{
    topic: string;
    namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[] }>;
  }>;
  disconnect(params: { topic: string; reason: unknown }): Promise<void>;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback: (...args: unknown[]) => void): void;
  request(params: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
  }): Promise<unknown>;
};

type WalletConnectSignClientModule = {
  default?: { init?(config: unknown): Promise<WalletConnectSignClient> };
  init?(config: unknown): Promise<WalletConnectSignClient>;
};

function isSessionGoneError(error: unknown): boolean {
  if (error instanceof Error && error.message.includes('WalletConnect session has expired')) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    /session/i.test(message) &&
    /(expired|not found|no matching|missing|unknown|deleted|closed|disconnect)/i.test(message)
  );
}

/**
 * Creates a WalletAdapter backed by WalletConnect v2, enabling mobile wallet
 * users to connect via QR code or deep link (issue #367).
 *
 * Dynamically imports `@walletconnect/sign-client` to avoid SSR issues.
 */
export async function createWalletConnectV2Adapter(
  config: WalletConnectV2AdapterConfig,
): Promise<WalletAdapter> {
  let mod: WalletConnectSignClientModule;
  try {
    mod = (await import('@walletconnect/sign-client')) as unknown as WalletConnectSignClientModule;
  } catch {
    throw new Error(
      'WalletConnect Sign Client is not installed. ' +
        'Run: npm install @walletconnect/sign-client',
    );
  }

  const initFn = mod.default?.init ?? mod.init;
  if (typeof initFn !== 'function') {
    throw new Error('WalletConnect Sign Client init function not found');
  }

  const signClient = await initFn({
    projectId: config.projectId,
    relayUrl: config.relayUrl,
    metadata: config.metadata,
  });

  const chainId = config.chainId ?? 'stellar:pubnet';
  let sessionTopic: string | null = null;
  let sessionExpiry: number | null = null;
  let publicKey: string | null = null;
  const connectionListeners = new Set<(connected: boolean) => void>();

  function emitConnection(connected: boolean): void {
    for (const cb of connectionListeners) cb(connected);
  }

  function invalidateSession(): void {
    if (sessionTopic === null) return;
    sessionTopic = null;
    sessionExpiry = null;
    publicKey = null;
    emitConnection(false);
  }

  function isSessionValid(): boolean {
    if (sessionTopic === null) return false;
    try {
      const session = (signClient as any).session?.get(sessionTopic);
      if (!session) return false;
      if (typeof session.expiry === 'number') {
        sessionExpiry = session.expiry;
        if (Date.now() / 1000 >= session.expiry) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function ensureSession(): Promise<string> {
    if (sessionTopic !== null) {
      if (isSessionValid()) return sessionTopic;
      invalidateSession();
    }

    const { topic, namespaces } = await signClient.connect({
      requiredNamespaces: {
        stellar: {
          methods: ['stellar_signXDR'],
          chains: [chainId],
          events: [],
        },
      },
    });

    sessionTopic = topic;
    sessionExpiry = null;
    publicKey = null;

    try {
      const session = (signClient as any).session?.get(topic);
      if (session && typeof session.expiry === 'number') {
        sessionExpiry = session.expiry;
      }
    } catch {}

    const stellarNs = namespaces['stellar'];
    if (stellarNs?.accounts?.length) {
      const parts = stellarNs.accounts[0]!.split(':');
      publicKey = parts[2] ?? null;
    }

    if (!publicKey) {
      throw new Error('WalletConnect session did not return a Stellar public key');
    }

    emitConnection(true);
    return sessionTopic;
  }

  signClient.on('session_delete', () => {
    invalidateSession();
  });
  signClient.on('session_expire', () => {
    invalidateSession();
  });

  return {
    async isConnected(): Promise<boolean> {
      return sessionTopic !== null && isSessionValid();
    },

    async getPublicKey(): Promise<string> {
      await ensureSession();
      return publicKey!;
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      const topic = await ensureSession();
      const passphrase = NETWORK_PASSPHRASES[network];

      let result: unknown;
      try {
        result = await signClient.request({
          topic,
          chainId,
          request: {
            method: 'stellar_signXDR',
            params: {
              xdr: xdrStr,
              networkPassphrase: passphrase,
            },
          },
        });
      } catch (error) {
        if (isSessionGoneError(error)) {
          invalidateSession();
          const { WalletConnectSessionExpiredError } = await import('./errors.js');
          throw new WalletConnectSessionExpiredError();
        }
        throw error;
      }

      if (typeof result === 'string') return result;
      const signed = result as { signedXdr?: string; signed_tx_xdr?: string };
      return signed.signedXdr ?? signed.signed_tx_xdr ?? xdrStr;
    },

    onConnectionChange(callback: (connected: boolean) => void): () => void {
      connectionListeners.add(callback);
      return () => {
        connectionListeners.delete(callback);
      };
    },

    async disconnect(): Promise<void> {
      if (!sessionTopic) return;
      try {
        await signClient.disconnect({
          topic: sessionTopic,
          reason: { code: 6000, message: 'User disconnected' },
        });
      } catch {}
      invalidateSession();
    },
  } as WalletAdapter & { disconnect(): Promise<void> };
}

// ── Issue #368: XDEFI wallet adapter ─────────────────────────────────────────

type XDEFIModule = {
  stellar: {
    isConnected(): Promise<boolean>;
    getPublicKey(): Promise<string>;
    sign(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
  };
};

/**
 * Creates a WalletAdapter backed by the XDEFI Wallet browser extension
 * (issue #368). Dynamically imports the XDEFI window provider to avoid SSR issues.
 *
 * @example
 * ```ts
 * import { createXDEFIAdapter } from "@sorostream/sdk/wallets";
 *
 * const adapter = await createXDEFIAdapter();
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "YOUR_CONTRACT_ID",
 *   walletAdapter: adapter,
 * });
 * ```
 */
export async function createXDEFIAdapter(): Promise<WalletAdapter> {
  if (typeof window === 'undefined') {
    throw new Error('XDEFI adapter is only available in browser environments');
  }

  // XDEFI injects `window.xdefi` (or `window.xfi`) with a Stellar provider
  const xdefi = (window as unknown as Record<string, unknown>)['xdefi'] as XDEFIModule | undefined;
  const xfi = (window as unknown as Record<string, unknown>)['xfi'] as XDEFIModule | undefined;
  const provider = xdefi?.stellar ?? xfi?.stellar;

  if (!provider) {
    throw new Error(
      'XDEFI Wallet is not installed. ' +
        'Visit https://xdefi.com to install the browser extension.',
    );
  }

  return {
    async isConnected(): Promise<boolean> {
      try {
        return await provider.isConnected();
      } catch {
        return false;
      }
    },

    async getPublicKey(): Promise<string> {
      const connected = await provider.isConnected();
      if (!connected) {
        throw new Error('XDEFI Wallet is not connected');
      }
      return provider.getPublicKey();
    },

    async signTransaction(xdrStr: string, network: Network): Promise<string> {
      const connected = await provider.isConnected();
      if (!connected) {
        throw new Error('XDEFI Wallet is not connected');
      }
      const passphrase = NETWORK_PASSPHRASES[network];
      return provider.sign(xdrStr, { networkPassphrase: passphrase });
    },
  };
}
