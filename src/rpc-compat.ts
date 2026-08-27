/**
 * Soroban RPC v2 Protocol Compatibility Layer (issue #272)
 *
 * Provides transparent support for both Soroban RPC v1 and v2 nodes.
 * Handles endpoint structure differences and response format normalization
 * so the rest of the SDK can work identically against either version.
 *
 * Protocol differences:
 *   v1: POST /  with JSON-RPC 2.0 method field
 *   v2: POST /v2/<method>  with JSON body (no method field), new response shapes
 */

import { rpc, type Account, type Transaction, type FeeBumpTransaction } from '@stellar/stellar-sdk';
import type { RpcTransportAdapter, RpcTransportGetEventsRequest } from './transport.js';
import { createDefaultRpcTransport } from './transport.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Which RPC protocol version to use. */
export type RpcVersion = 'v1' | 'v2' | 'auto';

/** Payload emitted on the `rpcVersionDetected` event. */
export interface RpcVersionDetectedPayload {
  /** The detected (or explicitly configured) version string, e.g. "v1" or "v2". */
  version: 'v1' | 'v2';
  /** The RPC URL that was probed. */
  rpcUrl: string;
  /** True when the version was auto-detected; false when explicitly overridden. */
  autoDetected: boolean;
  /**
   * Set when the node self-reported an API version this SDK build does not
   * recognise (e.g. `"v3"`). The transport falls back gracefully to the
   * closest supported protocol instead of throwing, and this field lets
   * integrations surface the mismatch themselves (issue #413).
   */
  unrecognizedVersion?: string;
}

/** Options for creating an RPC-compat transport. */
export interface RpcCompatTransportOptions {
  /**
   * Explicit version override. Use `"auto"` (default) to let the transport
   * probe the endpoint and detect the version on first use.
   */
  rpcVersion?: RpcVersion;
  /**
   * Timeout in ms for the version-probe request. Defaults to 5000.
   */
  probeTimeoutMs?: number;
  /**
   * Called once after the version is determined (either by probing or by
   * the explicit override). This is the hook the client uses to emit the
   * `rpcVersionDetected` event on the IEventBus.
   */
  onVersionDetected?: (payload: RpcVersionDetectedPayload) => void;
}

// ── v2 response shapes ────────────────────────────────────────────────────────

/**
 * RPC v2 health response shape.
 * v2 wraps status in a top-level `status` field.
 */
interface V2HealthResponse {
  status: string;
  latestLedger?: number;
  oldestLedger?: number;
}

/**
 * RPC v2 getLatestLedger response.
 */
interface V2LatestLedgerResponse {
  id: string;
  sequence: number;
  protocolVersion: string;
}

// ── Version detection ─────────────────────────────────────────────────────────

/**
 * API major versions this SDK build knows how to speak (issue #413).
 * Anything outside this set triggers a compatibility warning and a graceful
 * fallback instead of an error.
 */
const SUPPORTED_RPC_MAJORS: readonly number[] = [1, 2];

/**
 * Extracts a numeric API major version from an untrusted value self-reported
 * by a node. Accepts shapes like `3`, `"3"`, `"v3"`, or `"3.0.1"`.
 * Returns `null` when nothing recognisable can be extracted (issue #413).
 */
export function parseApiMajorVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const match = /^v?(\d+)/i.exec(value.trim());
    if (match) return parseInt(match[1]!, 10);
  }
  return null;
}

/** Fields a health payload may use to self-report the node's API version. */
function extractReportedApiVersion(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  return record['version'] ?? record['api_version'] ?? record['apiVersion'];
}

/** Result of probing an RPC endpoint for its protocol version. */
interface RpcVersionProbeResult {
  version: 'v1' | 'v2';
  /** Set when the node reported an API version outside SUPPORTED_RPC_MAJORS. */
  unrecognizedVersion?: string;
}

/**
 * Surfaces a clear compatibility warning when a node reports an API version
 * the SDK does not recognise, so integrations learn about the mismatch
 * immediately instead of hitting cryptic call failures later (issue #413).
 */
function warnUnrecognizedRpcVersion(rpcUrl: string, raw: unknown): void {
  console.warn(
    `[SoroStream] RPC node at ${rpcUrl} reports API version ${String(raw)}, which this SDK ` +
      `does not recognise (supported: v${Math.min(...SUPPORTED_RPC_MAJORS)}-v${Math.max(...SUPPORTED_RPC_MAJORS)}). ` +
      'Falling back to the closest supported protocol; upgrade @sorostream/sdk if calls fail.',
  );
}

/**
 * Probes an RPC URL to determine whether it speaks v1 or v2.
 *
 * Strategy:
 *   1. Try a lightweight v2-style GET to `/v2/health` — if it returns 200
 *      with a JSON body containing `status`, it is v2.
 *   2. If the body self-reports an API version this SDK does not recognise
 *      (e.g. a future `v3`), log a clear compatibility warning and fall back
 *      to the newest supported protocol instead of throwing (issue #413).
 *   3. Fall back to v1 on any error, non-200 status, or non-JSON body.
 *
 * This function never rejects — probe failures resolve to `"v1"`.
 */
async function probeRpcVersion(rpcUrl: string, timeoutMs = 5_000): Promise<RpcVersionProbeResult> {
  const url = rpcUrl.replace(/\/$/, '') + '/v2/health';
  try {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) {
        let body: V2HealthResponse;
        try {
          body = (await response.json()) as V2HealthResponse;
        } catch {
          // Non-JSON body from an unknown server flavour — treat as v1
          // rather than letting the parse error escape (issue #413).
          return { version: 'v1' };
        }
        // Issue #413: surface — but do not throw on — unrecognised versions.
        const reported = extractReportedApiVersion(body);
        const major = parseApiMajorVersion(reported);
        if (major !== null && !SUPPORTED_RPC_MAJORS.includes(major)) {
          warnUnrecognizedRpcVersion(rpcUrl, reported);
          // A node serving `/v2/health` at all most likely keeps v2
          // compatibility, so prefer it over legacy v1.
          return { version: 'v2', unrecognizedVersion: String(reported) };
        }
        if (typeof body?.status === 'string') {
          return { version: 'v2' };
        }
      }
    } finally {
      clearTimeout(timerId);
    }
  } catch {
    // Probe failed — treat as v1
  }
  return { version: 'v1' };
}

/**
 * Detects whether an RPC endpoint speaks v1 or v2.
 *
 * Never throws: network failures, non-200 responses, non-JSON bodies, and
 * unrecognised API versions all resolve gracefully (with a compatibility
 * warning for unrecognised versions) instead of propagating errors
 * (issue #413).
 */
export async function detectRpcVersion(rpcUrl: string, timeoutMs = 5_000): Promise<'v1' | 'v2'> {
  return (await probeRpcVersion(rpcUrl, timeoutMs)).version;
}

// ── v2 transport adapter ──────────────────────────────────────────────────────

/**
 * A thin transport adapter that speaks the Soroban RPC v2 wire protocol.
 *
 * v2 differences from v1:
 *   - Base path is `/v2`
 *   - Methods map to URL path segments: `/v2/getAccount`, `/v2/simulateTransaction` etc.
 *   - Request body is the plain parameters object (no JSON-RPC envelope)
 *   - Response body is the result directly (no `result` wrapper)
 *
 * Where the underlying `@stellar/stellar-sdk` `rpc.Server` already handles
 * the heavy lifting (XDR encoding, response decoding), we delegate and rely
 * on that. For methods that have genuinely divergent response shapes, we
 * normalize them here before returning to the SDK.
 *
 * In practice, the SDK's public `rpc.Server` from stellar-sdk serializes/
 * deserializes XDR and handles most response normalization. For v2 we wrap
 * the same transport but normalise the health/latestLedger responses which
 * have known shape differences.
 */
class RpcV2TransportAdapter implements RpcTransportAdapter {
  private readonly baseUrl: string;
  /** Underlying v1 adapter used for methods that haven't changed structurally. */
  private readonly v1: RpcTransportAdapter;

  constructor(rpcUrl: string) {
    this.baseUrl = rpcUrl.replace(/\/$/, '');
    // The stellar-sdk rpc.Server handles XDR encoding/decoding for all
    // mutating calls — we reuse it for those and only override the methods
    // that have response shape changes in v2.
    this.v1 = createDefaultRpcTransport(rpcUrl);
  }

  /** Low-level POST to a v2 endpoint. */
  private async postV2<TReq, TRes>(method: string, body: TReq): Promise<TRes> {
    const url = `${this.baseUrl}/v2/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`RPC v2 ${method} failed (${response.status}): ${text}`);
    }
    return (await response.json()) as TRes;
  }

  // ── Methods that have changed in v2 ────────────────────────────────────────

  async getHealth(): Promise<rpc.Api.GetHealthResponse> {
    const v2 = await this.postV2<Record<string, never>, V2HealthResponse>('health', {});
    // Normalize to the v1 shape expected by the rest of the SDK.
    return {
      status: v2.status as rpc.Api.GetHealthResponse['status'],
      ...(v2.latestLedger != null ? { latestLedger: v2.latestLedger } : {}),
      ...(v2.oldestLedger != null ? { oldestLedger: v2.oldestLedger } : {}),
    } as rpc.Api.GetHealthResponse;
  }

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    const v2 = await this.postV2<Record<string, never>, V2LatestLedgerResponse>(
      'getLatestLedger',
      {},
    );
    return {
      id: v2.id,
      sequence: v2.sequence,
      protocolVersion: v2.protocolVersion,
    };
  }

  // ── Methods that are structurally identical between v1 and v2 ─────────────
  // Delegate to the v1 stellar-sdk adapter which handles XDR correctly.

  getAccount(address: string): Promise<Account> {
    return this.v1.getAccount(address);
  }

  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return this.v1.getTransaction(hash);
  }

  simulateTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.v1.simulateTransaction(tx);
  }

  prepareTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<Transaction | FeeBumpTransaction> {
    return this.v1.prepareTransaction(tx);
  }

  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse> {
    return this.v1.sendTransaction(tx);
  }

  getEvents(request: RpcTransportGetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    return this.v1.getEvents(request);
  }
}

// ── Main factory ──────────────────────────────────────────────────────────────

/**
 * Creates an RPC transport that transparently supports both v1 and v2 nodes.
 *
 * When `rpcVersion` is `"auto"` (the default), the transport probes the
 * endpoint on first use and then routes all subsequent calls through the
 * appropriate adapter. The `onVersionDetected` callback fires once the
 * version is known.
 *
 * @example
 * ```ts
 * const transport = createRpcCompatTransport("https://soroban-testnet.stellar.org", {
 *   rpcVersion: "auto",
 *   onVersionDetected: ({ version }) => console.log("Detected RPC", version),
 * });
 * const client = new SoroStreamClient({ network: "testnet", contractId, transport });
 * ```
 */
export function createRpcCompatTransport(
  rpcUrl: string,
  options: RpcCompatTransportOptions = {},
): RpcTransportAdapter {
  const { probeTimeoutMs = 5_000, onVersionDetected } = options;
  let rpcVersion: RpcVersion = options.rpcVersion ?? 'auto';

  // Issue #413: wrap the consumer callback so a throwing listener can never
  // turn into an unhandled rejection inside the SDK's own initialisation.
  const notifyVersionDetected = (payload: RpcVersionDetectedPayload): void => {
    try {
      onVersionDetected?.(payload);
    } catch (error) {
      console.warn('[SoroStream] onVersionDetected callback threw:', error);
    }
  };

  // If a concrete version is requested, skip detection.
  if (rpcVersion !== 'auto') {
    // Issue #413: an explicit-but-unrecognised version (possible from plain
    // JS callers) must not fail silently later — warn and use the safest
    // known protocol.
    if (rpcVersion !== 'v1' && rpcVersion !== 'v2') {
      console.warn(
        `[SoroStream] Unknown rpcVersion "${String(rpcVersion)}"; falling back to "v1".`,
      );
      rpcVersion = 'v1';
    }

    const resolvedTransport =
      rpcVersion === 'v2' ? new RpcV2TransportAdapter(rpcUrl) : createDefaultRpcTransport(rpcUrl);

    // Fire the callback synchronously if no detection is needed.
    notifyVersionDetected({
      version: rpcVersion,
      rpcUrl,
      autoDetected: false,
    });

    return resolvedTransport;
  }

  // Auto-detect: initially wrap all calls behind a lazy-resolved delegate.
  let resolvedAdapter: RpcTransportAdapter | null = null;
  let detectionPromise: Promise<RpcTransportAdapter> | null = null;

  function getAdapter(): Promise<RpcTransportAdapter> {
    if (resolvedAdapter) return Promise.resolve(resolvedAdapter);
    if (detectionPromise) return detectionPromise;

    detectionPromise = probeRpcVersion(rpcUrl, probeTimeoutMs)
      .then((probe) => {
        const adapter =
          probe.version === 'v2'
            ? new RpcV2TransportAdapter(rpcUrl)
            : createDefaultRpcTransport(rpcUrl);
        resolvedAdapter = adapter;

        notifyVersionDetected({
          version: probe.version,
          rpcUrl,
          autoDetected: true,
          ...(probe.unrecognizedVersion !== undefined
            ? { unrecognizedVersion: probe.unrecognizedVersion }
            : {}),
        });

        return adapter;
      })
      .catch((error) => {
        // Issue #413: never leave callers with a permanently-rejected
        // detection promise — fall back to the default v1 transport and
        // surface a clear warning instead of an unhandled error.
        console.warn(
          `[SoroStream] RPC version probe failed for ${rpcUrl}; falling back to "v1".`,
          error,
        );
        const adapter = createDefaultRpcTransport(rpcUrl);
        resolvedAdapter = adapter;
        return adapter;
      });

    return detectionPromise;
  }

  // Kick off detection immediately on initialization rather than waiting for
  // the first RPC call, so `rpcVersionDetected` reflects "on init" as required.
  // The `.catch()` guard keeps this eager kick-off from ever producing an
  // unhandled rejection; real call errors still surface through the proxy
  // methods below (issue #413).
  void getAdapter().catch(() => {});

  // Return a proxy adapter that resolves the real adapter on first call.
  const proxy: RpcTransportAdapter = {
    serverURL: new URL(rpcUrl),
    async getAccount(address) {
      return (await getAdapter()).getAccount(address);
    },
    async getHealth() {
      return (await getAdapter()).getHealth();
    },
    async getLatestLedger() {
      return (await getAdapter()).getLatestLedger();
    },
    async getTransaction(hash) {
      return (await getAdapter()).getTransaction(hash);
    },
    async simulateTransaction(tx) {
      return (await getAdapter()).simulateTransaction(tx);
    },
    async prepareTransaction(tx) {
      return (await getAdapter()).prepareTransaction(tx);
    },
    async sendTransaction(tx) {
      return (await getAdapter()).sendTransaction(tx);
    },
    async getEvents(request) {
      return (await getAdapter()).getEvents(request);
    },
  };

  return proxy;
}
