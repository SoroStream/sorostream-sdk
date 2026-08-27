import {
  SoroStreamError,
  SoroStreamValidationError,
  FederationResolutionError,
  InsecureRpcUrlError,
} from './errors.js';
import { getDefaultWebSocketFactory } from './adapters.js';
import type { FetchAdapter, WebSocketFactory } from './adapters.js';
import { Memo, TransactionBuilder, Transaction, Networks } from '@stellar/stellar-sdk';
import type { FeeBumpTransaction } from '@stellar/stellar-sdk';
import type {
  PriceFeedAdapter,
  Stream,
  BulkStreamRow,
  TokenAggregate,
  VestingScheduleResult,
  WatchClaimableOptions,
  WebSocketReconnectOptions,
  FormatUSDCOptions,
  StreamDrift,
  ReconcileStreamOptions,
  StreamTotals,
  StatusBreakdown,
  DurationStats,
  StreamHealthReport,
  RecipientAggregate,
  CompressionOptions,
  StreamFilter,
  StreamSortField,
  SortOrder,
  Network,
  HorizonTransactionRecord,
  ParsedMemo,
  MemoHash,
  StreamHealthResult,
} from './types.js';

/** A single point in a stream's payout forecast. */
export interface PayoutSchedulePoint {
  /** Unix timestamp (seconds) for this sample. */
  timestamp: number;
  /** Cumulative tokens claimable from stream start up to `timestamp`, in stroops. */
  cumulativeClaimable: bigint;
}

const STROOP_FACTOR = 10_000_000n;

/**
 * Converts a token amount (as a decimal string like "100.50") to stroops/smallest unit.
 * Also handles scientific notation strings like "1e-3", "1.5e7", "2.5E-4".
 * @param amount - Amount as a decimal string (may be in scientific notation).
 * @param decimals - Number of decimal places the token uses (default 7 for SAC).
 */
export function toStroops(amount: string, decimals: number = 7): bigint {
  const trimmed = amount.trim();

  // Issue #451: expand scientific notation (e.g. "1e-3" → "0.001", "1.5e7" → "15000000")
  // before splitting on the decimal point so fractional exponents parse correctly.
  const expanded = /[eE]/.test(trimmed) ? expandScientific(trimmed) : trimmed;

  const negative = expanded.startsWith('-');
  const unsigned = negative ? expanded.slice(1) : expanded;
  const [whole = '0', decimal = ''] = unsigned.split('.');
  const factor = 10n ** BigInt(decimals);

  let value: bigint;
  if (decimal.length <= decimals) {
    const paddedDecimal = decimal.padEnd(decimals, '0');
    value = BigInt(whole || '0') * factor + BigInt(paddedDecimal || '0');
  } else {
    // Issue #409: round half-up instead of silently truncating extra fractional digits.
    const keep = decimal.slice(0, decimals);
    value = BigInt(whole || '0') * factor + BigInt(keep || '0');
    if (decimal.charCodeAt(decimals) >= 53 /* '5' */) {
      value += 1n;
    }
  }
  return negative ? -value : value;
}

/**
 * Expands a number string in scientific notation into a plain decimal string.
 * e.g. "1e-3" → "0.001", "1.5e7" → "15000000", "-2.5e-4" → "-0.00025"
 * @internal
 */
function expandScientific(s: string): string {
  // Match optional sign, significand (with optional decimal), and exponent.
  const match = s.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return s; // not parseable as scientific — let the caller handle it

  const sign = match[1] ?? '';
  const intPart = match[2] ?? '0';
  const fracPart = match[3] ?? '';
  const exp = parseInt(match[4]!, 10);

  // Combine significand digits (integer + fractional), then apply exponent.
  const digits = intPart + fracPart;
  // The decimal point was after intPart.length digits; after the shift it's at:
  const dotPos = intPart.length + exp;

  if (dotPos <= 0) {
    // All digits are to the right of the decimal point (e.g. 1e-3 → 0.001)
    return sign + '0.' + '0'.repeat(-dotPos) + digits;
  } else if (dotPos >= digits.length) {
    // All digits are to the left of the decimal point (e.g. 1.5e7 → 15000000)
    return sign + digits + '0'.repeat(dotPos - digits.length);
  } else {
    // Mixed (e.g. 1.234e1 → 12.34)
    return sign + digits.slice(0, dotPos) + '.' + digits.slice(dotPos);
  }
}

/**
 * Formats a stroop amount to a human-readable token string (e.g. "100.5000000").
 *
 * When `options` is provided, the result is locale-aware (grouping separators,
 * configurable decimal places). Without options, the existing precise
 * fixed-decimal string is returned unchanged — safe for calculations.
 *
 * @param stroops - Amount in the smallest token unit.
 * @param decimals - Number of decimal places the token uses (default 7 for SAC).
 * @param options - Optional locale formatting options.
 */
export function formatUSDC(
  stroops: bigint,
  decimals: number = 7,
  options?: FormatUSDCOptions,
): string {
  const factor = 10n ** BigInt(decimals);
  const whole = stroops / factor;
  const remainder = stroops % factor;

  if (!options) {
    return `${whole}.${remainder.toString().padStart(decimals, '0')}`;
  }

  // Build a numeric value from the bigint parts to avoid precision loss.
  // `whole` and `remainder` are each individually within Number.MAX_SAFE_INTEGER
  // for any realistic token amount.
  const numericValue = Number(whole) + Number(remainder) / Number(factor);

  return new Intl.NumberFormat(options.locale, {
    minimumFractionDigits: options.minimumFractionDigits ?? 2,
    maximumFractionDigits: options.maximumFractionDigits ?? decimals,
    useGrouping: options.useGrouping ?? true,
  }).format(numericValue);
}

/**
 * Generic alias for {@link formatUSDC}. Formats a stroop amount for any token.
 */
export function formatToken(stroops: bigint, decimals: number = 7): string {
  return formatUSDC(stroops, decimals);
}

/**
 * Converts a token amount to a fiat display value using a price feed adapter.
 *
 * @param stroops - Amount in the smallest token unit.
 * @param decimals - Number of decimal places the token uses.
 * @param priceFeed - Adapter that provides token-to-fiat pricing.
 * @param tokenAddress - The token contract address.
 * @param displayCurrency - Target currency code (default "usd").
 * @returns An object with both the token amount string and the fiat equivalent.
 */
export async function toFiatDisplay(
  stroops: bigint,
  decimals: number,
  priceFeed: PriceFeedAdapter,
  tokenAddress: string,
  displayCurrency = 'usd',
): Promise<{ tokenAmount: string; fiatAmount: string }> {
  const tokenAmount = formatToken(stroops, decimals);
  const pricePerUnit = await priceFeed.getPrice(tokenAddress, displayCurrency);

  const factor = 10n ** BigInt(decimals);
  const whole = stroops / factor;
  const remainder = stroops % factor;
  const fractional = Number(remainder) / Number(factor);
  const numericAmount = Number(whole) + fractional;
  const fiatValue = numericAmount * pricePerUnit;

  const fiatAmount = fiatValue.toFixed(2);
  return { tokenAmount, fiatAmount };
}

// ── Issue #202: Network auto-detection ──────────────────────────────────────

/**
 * Attempts to detect the Stellar network from an RPC URL.
 *
 * URLs containing `"testnet"` resolve to `"testnet"`; URLs containing
 * `"mainnet"` or `"horizon.stellar.org"` resolve to `"mainnet"`. Returns
 * `undefined` for URLs that don't match a known pattern (e.g. futurenet or
 * a custom/self-hosted RPC), in which case the network must be set explicitly.
 *
 * @param rpcUrl - The RPC endpoint URL to inspect.
 * @returns The detected network, or `undefined` if it can't be determined.
 */
export function detectNetworkFromRpcUrl(rpcUrl: string): Network | undefined {
  const lower = rpcUrl.toLowerCase();
  if (lower.includes('testnet')) return 'testnet';
  if (lower.includes('mainnet') || lower.includes('horizon.stellar.org')) return 'mainnet';
  return undefined;
}

/** Loopback hosts exempt from the HTTPS-only RPC URL requirement (local dev). */
const LOOPBACK_RPC_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Rejects non-TLS (`http://`) RPC endpoint URLs so transaction data — including
 * signed envelopes — is never routed over an unencrypted connection (issue #463).
 *
 * Loopback hosts (`localhost`, `127.0.0.1`, `::1`) are exempt so local Soroban
 * quickstart / standalone-network workflows keep working. URLs that fail to
 * parse are left for the RPC transport to reject with its own error.
 *
 * @throws {InsecureRpcUrlError} When `rpcUrl` is an `http://` URL for a non-loopback host.
 */
export function assertSecureRpcUrl(rpcUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    return;
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_RPC_HOSTS.has(parsed.hostname)) {
    throw new InsecureRpcUrlError(rpcUrl);
  }
}

/**
 * Checks whether a string looks like a valid Stellar address (account or contract).
 */
export function isValidStellarAddress(address: string): boolean {
  return typeof address === 'string' && /^[GC][A-Z2-7]{55}$/.test(address);
}

/**
 * Returns true when the string is a Stellar federation address (user*domain.com format).
 */
export function isFederationAddress(address: string): boolean {
  return typeof address === 'string' && /^[^*\s]+\*[^*\s]+\.[^*\s]+$/.test(address);
}

/**
 * Resolves a Stellar federation address (user*domain.com) to a raw Stellar public key.
 * Fetches the domain's stellar.toml to discover the federation server, then queries it.
 * Throws {@link FederationResolutionError} if the server is unreachable or the address is unknown.
 */
export async function resolveFederationAddress(
  federationAddress: string,
  fetchImpl: FetchAdapter = fetch,
): Promise<string> {
  const starIdx = federationAddress.indexOf('*');
  if (starIdx === -1) {
    throw new FederationResolutionError(federationAddress, 'invalid federation address format');
  }
  const domain = federationAddress.slice(starIdx + 1);
  if (!domain) {
    throw new FederationResolutionError(federationAddress, 'missing domain');
  }

  let federationServer: string;
  try {
    const tomlRes = await fetchImpl(`https://${domain}/.well-known/stellar.toml`);
    if (!tomlRes.ok) throw new Error(`HTTP ${tomlRes.status}`);
    const tomlText = await tomlRes.text();
    const match = /FEDERATION_SERVER\s*=\s*"([^"]+)"/.exec(tomlText);
    if (!match?.[1]) throw new Error('FEDERATION_SERVER not found in stellar.toml');
    federationServer = match[1];
  } catch (err) {
    throw new FederationResolutionError(
      federationAddress,
      `stellar.toml unreachable: ${String(err)}`,
    );
  }

  try {
    const fedRes = await fetchImpl(
      `${federationServer}?q=${encodeURIComponent(federationAddress)}&type=name`,
    );
    if (!fedRes.ok) throw new Error(`HTTP ${fedRes.status}`);
    const json = (await fedRes.json()) as { account_id?: string };
    const resolved = json.account_id;
    if (!resolved || !isValidStellarAddress(resolved)) {
      throw new Error('no valid account_id in federation response');
    }
    return resolved;
  } catch (err) {
    throw new FederationResolutionError(
      federationAddress,
      `federation server query failed: ${String(err)}`,
    );
  }
}

/**
 * Calculates the largest per-second flow rate such that `flowRate * durationSeconds <= totalAmount`.
 *
 * @param totalAmount - Total amount to stream in stroops. Must be > 0.
 * @param durationSeconds - Stream duration in seconds. Must be > 0.
 * @returns The per-second flow rate in stroops (integer division).
 * @throws {SoroStreamError} If totalAmount or durationSeconds is zero or negative.
 *
 * @example
 * ```ts
 * const rate = calculateFlowRate(toStroops("100"), 30 * 24 * 60 * 60);
 * // rate * duration <= totalAmount is always satisfied
 * ```
 */
export function calculateFlowRate(totalAmount: bigint, durationSeconds: number): bigint {
  if (totalAmount <= 0n) throw new SoroStreamError('totalAmount must be > 0');
  if (durationSeconds <= 0) throw new SoroStreamError('durationSeconds must be > 0');
  return totalAmount / BigInt(durationSeconds);
}

/** Time unit for {@link toRatePerSecond} and {@link fromRatePerSecond}. */
export type RateUnit = 'second' | 'minute' | 'hour' | 'day' | 'week';

const RATE_UNIT_SECONDS: Record<RateUnit, bigint> = {
  second: 1n,
  minute: 60n,
  hour: 3_600n,
  day: 86_400n,
  week: 604_800n,
};

/**
 * Converts a human-readable token amount per `unit` into a stroop-per-second
 * on-chain flow rate.
 *
 * @param amount - Total stroops flowing per `unit` (e.g. `toStroops("10")` for 10 USDC/day).
 * @param unit - The time unit the `amount` refers to (default `"second"`).
 * @returns The equivalent flow rate in stroops per second (integer division).
 * @throws {SoroStreamError} When `amount` is not positive.
 *
 * @example
 * ```ts
 * // 10 USDC per day expressed as stroops/second
 * const rate = toRatePerSecond(toStroops("10"), "day");
 * ```
 */
export function toRatePerSecond(amount: bigint, unit: RateUnit = 'second'): bigint {
  if (amount <= 0n) throw new SoroStreamError('amount must be > 0');
  const unitSeconds = RATE_UNIT_SECONDS[unit];
  return amount / unitSeconds;
}

/**
 * Converts a stroop-per-second on-chain flow rate back into a human-readable
 * stroops-per-`unit` value.
 *
 * @param stroopsPerSecond - The raw on-chain flow rate in stroops/second.
 * @param unit - The time unit to normalise into (default `"second"`).
 * @returns The equivalent amount of stroops that flow within one `unit`.
 * @throws {SoroStreamError} When `stroopsPerSecond` is negative.
 *
 * @example
 * ```ts
 * // How many stroops flow per day?
 * const dailyStroops = fromRatePerSecond(stream.flowRate, "day");
 * console.log(formatUSDC(dailyStroops)); // "10.0000000"
 * ```
 */
export function fromRatePerSecond(stroopsPerSecond: bigint, unit: RateUnit = 'second'): bigint {
  if (stroopsPerSecond < 0n) throw new SoroStreamError('stroopsPerSecond must be >= 0');
  const unitSeconds = RATE_UNIT_SECONDS[unit];
  return stroopsPerSecond * unitSeconds;
}

/**
 * Returns true when the stream's end time has passed.
 *
 * `stream.endTime` is stored in **Unix seconds** (on-chain value).
 * `Date.now()` returns milliseconds, so we divide by 1000 before comparing.
 *
 * @param stream - The stream object.
 * @param now - Optional override for "now" in Unix seconds (default: `Date.now() / 1000`).
 */
export function isExpired(stream: Stream, now?: number): boolean {
  const nowSecs = now ?? Date.now() / 1000;
  return stream.endTime < nowSecs;
}

/**
 * Returns the number of seconds remaining until the stream ends.
 * Returns 0 if the stream has already ended.
 * @param stream - The stream object.
 */
export function timeUntilStreamEnd(stream: Stream): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, stream.endTime - now);
}

/**
 * Calculates the currently claimable amount in stroops based on local time.
 * This is an estimate — the contract is the source of truth.
 * @param stream - The stream object.
 */
export function claimableNow(stream: Stream): bigint {
  if (stream.status !== 'Active') return 0n;
  const now = Math.floor(Date.now() / 1000);
  const effectiveNow = Math.min(now, stream.endTime);
  const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
  return stream.flowRate * BigInt(elapsed);
}

/**
 * Computes a display-only vesting schedule that approximates a cliff.
 *
 * The contract streams linearly from `startTime` with no cliff concept.
 * A "4-year vesting with 1-year cliff" can only be approximated by adjusting
 * the displayed schedule — **this is NOT enforced on-chain**.
 *
 * All duration / elapsed / milestone arithmetic is performed in BigInt so that
 * streams whose `flowRate × duration` exceeds `Number.MAX_SAFE_INTEGER`
 * (≈9.007e15) do not lose precision through implicit Number coercions.
 * The `time` field of each milestone is the only place we round back to Number
 * since Unix timestamps must be representable as Numbers.
 *
 * @param stream - The stream object.
 * @param cliffSeconds - Duration of the cliff period in seconds.
 * @param now - Optional override for "current" time (Unix seconds). Defaults to Date.now().
 */
export function calculateVestingSchedule(
  stream: Stream,
  cliffSeconds: number,
  now?: number,
): VestingScheduleResult {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const cliffEndTime = stream.startTime + cliffSeconds;
  const inCliff = currentTime < cliffEndTime;

  // Promote all duration / elapsed arithmetic to BigInt so we never round
  // intermediate counts through Number. This keeps totalAmount, vested
  // amounts, and effectiveClaimable exact when stream.flowRate × duration
  // exceeds Number.MAX_SAFE_INTEGER.
  const totalSecondsBig = BigInt(stream.endTime - stream.startTime);
  const cliffSecondsBig = BigInt(cliffSeconds);
  const totalAmount = stream.flowRate * totalSecondsBig;

  let effectiveClaimable: bigint;
  if (inCliff) {
    effectiveClaimable = 0n;
  } else if (currentTime >= stream.endTime) {
    effectiveClaimable = totalAmount;
  } else {
    // Elapsed seconds from end-of-cliff (or from startTime when no cliff)
    // up to min(now, endTime).
    const minNowBig = BigInt(Math.min(currentTime, stream.endTime));
    const vestingStartBig = BigInt(Math.max(cliffEndTime, stream.startTime));
    const elapsedBig = minNowBig > vestingStartBig ? minNowBig - vestingStartBig : 0n;
    effectiveClaimable = stream.flowRate * (cliffSecondsBig + elapsedBig);
  }

  const milestones: Array<{ time: number; vested: bigint }> = [];

  if (cliffSecondsBig < totalSecondsBig) {
    milestones.push({
      time: cliffEndTime,
      vested: stream.flowRate * cliffSecondsBig,
    });
  }

  // Use integer percentage literals (25n, 50n, 75n, 100n) and divide in
  // BigInt — this avoids `Math.floor(totalSeconds × decimalPct)` losing
  // precision when totalSeconds is large. The final `Number()` cast below
  // is for the `time` Unix-timestamp field and is the only intentional
  // Number conversion.
  for (const pct of [25n, 50n, 75n, 100n] as const) {
    const secondsAtPct = (totalSecondsBig * pct) / 100n;
    const t = stream.startTime + Number(secondsAtPct);
    if (t > cliffEndTime) {
      milestones.push({
        time: t,
        vested: stream.flowRate * secondsAtPct,
      });
    }
  }

  milestones.sort((a, b) => a.time - b.time);

  return {
    effectiveClaimable,
    totalAmount,
    cliffEndTime,
    inCliff,
    milestones,
  };
}

/**
 * Subscribes to real-time claimable balance updates via WebSocket.
 *
 * Returns an unsubscribe function. Falls back to a no-op if WebSocket is
 * unavailable or the connection fails, relying on the caller to provide
 * a fallback mechanism.
 *
 * @param wsUrl - WebSocket endpoint URL.
 * @param streamId - The stream ID to subscribe to.
 * @param onClaimable - Callback invoked with the latest on-chain claimable value.
 * @returns A function that closes the WS connection when called.
 *
 * @example
 * ```ts
 * const stop = watchClaimableWs("wss://rpc.example.com/ws", "42", (v) => {
 *   console.log("On-chain claimable:", v);
 * });
 * // later: stop();
 * ```
 */
/**
 * Resolves a `compression` option into a normalised `CompressionOptions` object,
 * or `null` when compression is disabled (the default).
 */
function resolveCompression(
  compression: boolean | CompressionOptions | undefined,
): CompressionOptions | null {
  if (!compression) return null;
  if (compression === true) return { level: 6, threshold: 128 };
  return { level: compression.level ?? 6, threshold: compression.threshold ?? 128 };
}

export function watchClaimableWs(
  wsUrl: string,
  streamId: string,
  onClaimable: (claimable: bigint) => void,
  compression?: boolean | CompressionOptions,
  webSocketFactory?: WebSocketFactory,
  reconnectOptions?: { reconnect?: boolean; backoffMs?: number; maxAttempts?: number },
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let lastEmittedValue: bigint | null = null;
  const shouldReconnect = reconnectOptions?.reconnect ?? true;
  const backoffMs = reconnectOptions?.backoffMs ?? 100;
  const maxAttempts = reconnectOptions?.maxAttempts ?? 10;

  const compressionOpts = resolveCompression(compression);
  const payloadThreshold = compressionOpts?.threshold ?? Infinity;
  const createWebSocket = webSocketFactory ?? getDefaultWebSocketFactory();
  if (!createWebSocket) {
    throw new Error(
      'watchClaimableWs: no WebSocket implementation available. Pass `webSocketFactory` ' +
        'in environments without a global WebSocket (e.g. React Native — see @sorostream/sdk-react-native).',
    );
  }

  function connect() {
    if (stopped) return;
    try {
      if (compressionOpts) {
        try {
          const deflateOpts = { perMessageDeflate: { level: compressionOpts.level } };
          ws = createWebSocket!(wsUrl, deflateOpts);
        } catch {
          ws = createWebSocket!(wsUrl);
        }
      } else {
        ws = createWebSocket!(wsUrl);
      }

      ws.onopen = () => {
        if (stopped) return;
        reconnectAttempts = 0;
        const msg = JSON.stringify({ type: 'subscribe', streamId });
        ws?.send(msg);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (stopped) return;
        try {
          const data = JSON.parse(event.data as string);
          if (data.type === 'claimable' && data.streamId === streamId) {
            const val = BigInt(data.value);
            if (val !== lastEmittedValue) {
              lastEmittedValue = val;
              onClaimable(val);
            }
          }
        } catch {
          // swallow parse errors
        }
      };

      ws.onerror = () => {
        // Silently swallow errors; close event will trigger reconnect if appropriate
      };

      ws.onclose = () => {
        if (stopped) return;
        if (shouldReconnect && reconnectAttempts < maxAttempts) {
          reconnectAttempts++;
          const delay = backoffMs * Math.pow(1.5, reconnectAttempts - 1);
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    } catch {
      // WebSocket initialization failed
    }
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };
}

/**
 * Creates a live "counting up" ticker for the claimable balance of a stream.
 *
 * Emits smoothly interpolated claimable values on an interval, reconciled
 * periodically against the on-chain `getClaimable` value. Returns an unsubscribe
 * function to stop the ticker.
 *
 * When `options.wsUrl` is provided, the function also subscribes to real-time
 * WebSocket updates from the RPC endpoint. The WS handler updates the base
 * value used for interpolation, providing more accurate estimates between
 * polling reconciliations. Falls back to polling-only if WS is unavailable.
 *
 * @param stream - The stream object.
 * @param reconcile - Async function that fetches the current on-chain claimable (typically `client.getClaimable(id)`).
 * @param onTick - Callback invoked with the current interpolated claimable value in stroops.
 * @param options - Optional configuration.
 * @returns A function that stops the ticker when called.
 *
 * @example
 * ```ts
 * const unsubscribe = watchClaimable(
 *   stream,
 *   () => client.getClaimable(stream.id),
 *   (claimable) => { displayElement.textContent = formatUSDC(claimable); }
 * );
 * // later: unsubscribe();
 * ```
 *
 * @example
 * ```ts
 * // With WebSocket subscription for real-time updates
 * const unsubscribe = watchClaimable(
 *   stream,
 *   () => client.getClaimable(stream.id),
 *   (claimable) => { displayElement.textContent = formatUSDC(claimable); },
 *   { wsUrl: "wss://rpc.example.com/ws", wsStreamId: stream.id }
 * );
 * ```
 */
// Issue #340: Subscription reference-count cache for watchClaimable.
// Reuses the same polling interval for identical stream IDs, preventing
// memory leaks when the same stream is watched multiple times.
const watchClaimableSubscriptions = new Map<
  string,
  {
    count: number;
    tickTimer: ReturnType<typeof setInterval>;
    reconcileTimer: ReturnType<typeof setInterval>;
    stopWs: (() => void) | null;
    listeners: Set<(claimable: bigint) => void>;
    baseValue: bigint;
    baseTime: number;
    lastEmitted: bigint | null;
    stream: Stream;
    stopped: boolean;
  }
>();

export function watchClaimable(
  stream: Stream,
  reconcile: () => Promise<bigint>,
  onTick: (claimable: bigint) => void,
  options?: WatchClaimableOptions,
): () => void {
  const tickMs = options?.tickMs ?? 200;
  const reconcileMs = options?.reconcileMs ?? 5_000;
  let baseValue = claimableNow(stream);
  let baseTime = Date.now();
  let lastEmitted: bigint | null = null;
  let stopped = false;
  let lastNetworkVersion = options?.getNetworkVersion?.();
  // Issue #385: fire onStreamCompleted exactly once when stream reaches endTime.
  let completedFired = false;

  function maybeFireCompleted(): void {
    if (completedFired || stopped || !options?.onStreamCompleted) return;
    const nowSecs = Date.now() / 1000;
    if (nowSecs >= stream.endTime) {
      completedFired = true;
      const summary: StreamCompletedSummary = {
        streamId: stream.id,
        totalStreamed: stream.deposit,
        endTime: stream.endTime,
      };
      options.onStreamCompleted(stream.id, summary);
    }
  }

  function emit() {
    if (stopped) return;
    const elapsedMs = Date.now() - baseTime;
    const perMs = Number(stream.flowRate) / 1000;
    const interpolated = baseValue + BigInt(Math.floor(perMs * elapsedMs));
    // Deduplicate emissions across all three emit sources (tickTimer,
    // reconcile, and the optional WebSocket subscription). Without dedup,
    // reconcile (or WS) returning the same bigint that the most recent
    // tick already interpolated to would call onTick twice — once from the
    // last cached tick, once from the fresh fetch. The most common path
    // is a network blip: ticks keep interpolating from a stale baseValue,
    // then reconcile recovers and immediately calls emit() with a value
    // that matches the last cached value. The same dedup also (correctly)
    // keeps sub-stroop ticks quiet when Math.floor(perMs * elapsedMs)
    // rounds to zero between stroop increments — so it is always-on, not
    // a network-recovery-specific hack.
    if (interpolated === lastEmitted) return;
    lastEmitted = interpolated;
    onTick(interpolated);
    // Issue #385: check completion on every tick.
    maybeFireCompleted();
  }

  // Seed the dedupe cache BEFORE the initial onTick so that a re-entrant
  // onTick callback (e.g. one that synchronously triggers another
  // emit() path) cannot be dropped as a duplicate of the uninitialised
  // cache sentinel.
  lastEmitted = baseValue;
  onTick(baseValue);

  let tickTimer = setInterval(emit, tickMs);
  let reconcileTimer: ReturnType<typeof setInterval>;

  function restartPolling() {
    clearInterval(tickTimer);
    clearInterval(reconcileTimer);
    stopWs?.();
    baseValue = claimableNow(stream);
    baseTime = Date.now();
    lastEmitted = null;
    tickTimer = setInterval(emit, tickMs);
    reconcileTimer = setInterval(reconcileTick, reconcileMs);
    emit();
  }

  async function reconcileTick() {
    if (stopped) return;

    // Issue #228: detect network switch mid-session and restart polling
    const currentVersion = options?.getNetworkVersion?.();
    if (options?.getNetworkVersion && currentVersion !== lastNetworkVersion) {
      lastNetworkVersion = currentVersion;
      options.onNetworkChanged?.();
      restartPolling();
      return;
    }

    try {
      const actual = await reconcile();
      baseValue = actual;
      baseTime = Date.now();
      emit();
      // Issue #385: also check completion after each reconcile.
      maybeFireCompleted();
    } catch {
      // swallow — keep interpolating from last known value
    }
  }

  reconcileTimer = setInterval(reconcileTick, reconcileMs);

  // Optional WebSocket subscription for real-time on-chain updates
  let stopWs: (() => void) | null = null;
  if (options?.wsUrl && options?.wsStreamId) {
    stopWs = watchClaimableWs(
      options.wsUrl,
      options.wsStreamId,
      (actual) => {
        baseValue = actual;
        baseTime = Date.now();
        emit();
      },
      options.compression,
      options.webSocketFactory,
      options.wsReconnectOptions,
    );
  }

  // Issue #407: On wake from device sleep, `setInterval` callbacks may be
  // delayed or skipped entirely. Register `visibilitychange` and `pageshow`
  // listeners to immediately re-anchor the base time and trigger a
  // reconciliation so the displayed claimable balance is not stale.
  function handleWake(): void {
    if (stopped) return;
    // Only act when the page becomes visible (not on hide).
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // Re-anchor the base time so interpolation doesn't jump backward.
    baseTime = Date.now();
    // Trigger an immediate reconcile to get a fresh on-chain value.
    void reconcileTick();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleWake);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', handleWake);
  }

  return () => {
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(reconcileTimer);
    stopWs?.();
    // Issue #407: clean up wake listeners
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleWake);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', handleWake);
    }
  };
}

/** Options for {@link watchTotalClaimable}. */
export interface WatchTotalClaimableOptions extends WatchClaimableOptions {}

// ── Issue #47: Cache reconciliation / drift detection ────────────────────────

const DRIFT_FIELDS: ReadonlyArray<keyof Stream> = [
  'status',
  'deposit',
  'flowRate',
  'endTime',
  'lastWithdrawTime',
  'autoRenew',
];

/**
 * Compares a cached stream against a fresh on-chain stream and returns any
 * fields that differ. Returns an empty array when there is no drift.
 *
 * Only mutable fields are compared (status, deposit, flowRate, endTime,
 * lastWithdrawTime, autoRenew). Immutable fields (id, sender, recipient,
 * token, startTime) are excluded.
 *
 * @param cached - The locally cached stream state.
 * @param onChain - The freshly fetched on-chain stream state.
 */
export function detectStreamDrift(cached: Stream, onChain: Stream): StreamDrift[] {
  const diffs: StreamDrift[] = [];
  for (const field of DRIFT_FIELDS) {
    if (String(cached[field]) !== String(onChain[field])) {
      diffs.push({ field, cached: cached[field], onChain: onChain[field] });
    }
  }
  return diffs;
}

/**
 * Periodically compares a cached stream against the on-chain state and invokes
 * `onDrift` whenever a difference is detected. Useful for catching missed
 * cache invalidations in long-running applications.
 *
 * Performs an immediate first check, then continues at the configured interval.
 * The internal reference is updated on every successful fetch so that callers
 * receive diffs relative to the most recent known state.
 *
 * @param stream - The initial cached stream.
 * @param fetchOnChain - Async function that returns the current on-chain stream.
 * @param onDrift - Called when drift is detected, with the diff list and fresh stream.
 * @param options - Optional configuration (intervalMs, default 30 000).
 * @returns Unsubscribe function that stops the watcher.
 *
 * @example
 * ```ts
 * const stop = watchStreamDrift(
 *   cachedStream,
 *   () => client.getStream(cachedStream.id),
 *   (diffs, fresh) => console.log("Drift detected:", diffs),
 * );
 * // later: stop();
 * ```
 */
export function watchStreamDrift(
  stream: Stream,
  fetchOnChain: () => Promise<Stream>,
  onDrift: (diffs: StreamDrift[], fresh: Stream) => void,
  options?: ReconcileStreamOptions,
): () => void {
  const intervalMs = options?.intervalMs ?? 30_000;
  let current = stream;
  let stopped = false;

  async function check() {
    if (stopped) return;
    try {
      const fresh = await fetchOnChain();
      if (stopped) return; // re-check after async gap in case stop() was called
      const diffs = detectStreamDrift(current, fresh);
      current = fresh; // always update reference to the latest known state
      if (diffs.length > 0) {
        onDrift(diffs, fresh);
      }
    } catch {
      // swallow errors — keep watching from last known value
    }
  }

  // Immediate first check
  void check();

  const timer = setInterval(check, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Checks whether an active stream is approaching its end time.
 * @param stream - The stream object.
 * @param thresholdSeconds - Seconds threshold (default 86400 = 24h).
 */
export function isStreamExpiring(stream: Stream, thresholdSeconds: number = 86400): boolean {
  if (stream.status !== 'Active') return false;
  const remaining = timeUntilStreamEnd(stream);
  return remaining > 0 && remaining < thresholdSeconds;
}

/**
 * Checks whether an active stream has stalled (no recent withdrawals).
 * @param stream - The stream object.
 * @param staleThresholdSeconds - Seconds since last withdraw to consider stalled (default 604800 = 7d).
 */
export function isStreamStalled(stream: Stream, staleThresholdSeconds: number = 604800): boolean {
  if (stream.status !== 'Active') return false;
  const now = Math.floor(Date.now() / 1000);
  return now - stream.lastWithdrawTime > staleThresholdSeconds;
}

/**
 * Checks whether a stream is under-funded — the remaining deposit is
 * insufficient to sustain the flow rate until the current end time.
 * This can happen when deposit rounding leaves a shortfall or when
 * top-up amounts were too small to meaningfully extend the stream.
 * @param stream - The stream object.
 */
export function isStreamUnderfunded(stream: Stream): boolean {
  if (stream.status !== 'Active' || stream.flowRate === 0n) return false;
  const streamedSoFar = stream.flowRate * BigInt(stream.lastWithdrawTime - stream.startTime);
  const remainingDeposit = stream.deposit - streamedSoFar;
  const expectedRemaining = stream.flowRate * BigInt(stream.endTime - stream.lastWithdrawTime);
  return remainingDeposit < expectedRemaining;
}

// ── Stream filtering / sorting (issue #204) ─────────────────────────────────

/**
 * Filters a list of streams by status, sender, recipient, token, active-only,
 * and/or date-range bounds (on `startTime` / `endTime`). All provided criteria
 * are ANDed together.
 *
 * Date bounds are inclusive and expressed in Unix seconds, matching the
 * `startTime` / `endTime` fields on {@link Stream}.
 *
 * @param streams - Streams to filter.
 * @param filters - Criteria to filter by. Omitted fields are not checked.
 * @returns A new array containing only the matching streams.
 *
 * @example
 * ```ts
 * // Streams started within the last 30 days for a given token
 * const monthAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
 * const recent = filterStreams(streams, {
 *   token: usdcAddress,
 *   status: "Active",
 *   startTimeFrom: monthAgo,
 * });
 * ```
 */
export function filterStreams(streams: Stream[], filters: StreamFilter): Stream[] {
  return streams.filter((s) => {
    if (filters.status !== undefined && s.status !== filters.status) return false;
    if (filters.sender !== undefined && s.sender !== filters.sender) return false;
    if (filters.recipient !== undefined && s.recipient !== filters.recipient) return false;
    if (filters.token !== undefined && s.token !== filters.token) return false;
    if (filters.activeOnly && (s.status !== 'Active' || isExpired(s))) return false;
    if (filters.startTimeFrom !== undefined && s.startTime < filters.startTimeFrom) return false;
    if (filters.startTimeTo !== undefined && s.startTime > filters.startTimeTo) return false;
    if (filters.endTimeFrom !== undefined && s.endTime < filters.endTimeFrom) return false;
    if (filters.endTimeTo !== undefined && s.endTime > filters.endTimeTo) return false;
    return true;
  });
}

/**
 * Returns a new array of streams sorted by the given field.
 *
 * @param streams - Streams to sort (not mutated).
 * @param by - Field to sort by. `"amount"` sorts by `deposit`.
 * @param order - Sort direction (default `"asc"`).
 * @returns A new, sorted array.
 */
export function sortStreams(
  streams: Stream[],
  by: StreamSortField,
  order: SortOrder = 'asc',
): Stream[] {
  const direction = order === 'desc' ? -1 : 1;
  return [...streams].sort((a, b) => {
    const diff = by === 'amount' ? a.deposit - b.deposit : BigInt(a[by]) - BigInt(b[by]);
    return (diff < 0n ? -1 : diff > 0n ? 1 : 0) * direction;
  });
}

// ── Token aggregation ─────────────────────────────────────────────────────────

/**
 * Groups streams by token address and returns per-token aggregates.
 * Uses the client-side `claimableNow` for claimable estimates.
 *
 * @param streams - Stream list (e.g. from getStreamsByRecipient).
 * @returns Per-token aggregates sorted by deposited amount descending.
 *
 * @example
 * ```ts
 * const streams = await client.getStreamsByRecipient(recipient);
 * const agg = aggregateStreamsByToken(streams);
 * for (const t of agg) console.log(t.token, t.claimable);
 * ```
 */
export function aggregateStreamsByToken(streams: Stream[]): TokenAggregate[] {
  const map = new Map<string, TokenAggregate>();

  for (const s of streams) {
    const existing = map.get(s.token) ?? {
      token: s.token,
      streamCount: 0,
      deposited: 0n,
      claimable: 0n,
      claimedSoFar: 0n,
    };
    existing.streamCount += 1;
    existing.deposited += s.deposit;
    existing.claimable += claimableNow(s);
    existing.claimedSoFar += s.deposit - s.flowRate * BigInt(s.endTime - s.lastWithdrawTime);
    map.set(s.token, existing);
  }

  return [...map.values()].sort((a, b) => {
    if (b.deposited > a.deposited) return 1;
    if (b.deposited < a.deposited) return -1;
    return 0;
  });
}

// ── Dashboard / reporting aggregators ─────────────────────────────────────────

/**
 * Aggregates total deposited, claimable, claimed, and remaining amounts
 * across a set of streams.
 *
 * @param streams - Stream list.
 * @returns Aggregate totals.
 *
 * @example
 * ```ts
 * const totals = totalValueStreamed(streams);
 * console.log(totals.totalDeposited, totals.totalClaimable);
 * ```
 */
export function totalValueStreamed(streams: Stream[]): StreamTotals {
  let totalDeposited = 0n;
  let totalClaimable = 0n;
  let totalClaimed = 0n;
  let totalRemaining = 0n;

  for (const s of streams) {
    totalDeposited += s.deposit;
    totalClaimable += claimableNow(s);
    const claimed = s.deposit - s.flowRate * BigInt(s.endTime - s.lastWithdrawTime);
    totalClaimed += claimed > 0n ? claimed : 0n;
    totalRemaining += s.deposit - (claimed > 0n ? claimed : 0n);
  }

  return {
    totalStreams: streams.length,
    totalDeposited,
    totalClaimable,
    totalClaimed,
    totalRemaining,
  };
}

// ── Issue #386: aggregateStreams ──────────────────────────────────────────────

/**
 * Computes cross-stream analytics — total value locked, average flow rate, and
 * a per-status breakdown — across any set of streams.
 *
 * Unlike {@link totalValueStreamed} (which sums all deposits), `totalValueLocked`
 * reflects only the remaining deposits held by active streams, making it a
 * meaningful on-chain "TVL" metric for dashboards.
 *
 * @param streams - Stream list (may be empty; all statuses are accepted).
 * @returns An {@link StreamsAggregate} object with TVL, averageRate, and statusBreakdown.
 *
 * @example
 * ```ts
 * const agg = aggregateStreams(await client.getStreamsBySender(sender));
 * console.log(formatUSDC(agg.totalValueLocked)); // e.g. "9500.0000000"
 * console.log(agg.statusBreakdown); // { active: 3, cancelled: 1, completed: 2 }
 * ```
 *
 * Issue #386.
 */
export function aggregateStreams(streams: Stream[]): StreamsAggregate {
  let totalValueLocked = 0n;
  let rateSum = 0n;
  let activeCount = 0;
  let cancelled = 0;
  let completed = 0;

  const nowSecs = Math.floor(Date.now() / 1000);

  for (const s of streams) {
    if (s.status === 'Active') {
      activeCount++;
      // TVL: deposit minus what has already been released by the stream.
      // Released = flowRate × elapsed, where elapsed = min(now, endTime) - startTime.
      const effectiveNow = Math.min(nowSecs, s.endTime);
      const elapsedSecs = BigInt(Math.max(0, effectiveNow - s.startTime));
      const released = s.flowRate * elapsedSecs;
      const remaining = s.deposit > released ? s.deposit - released : 0n;
      totalValueLocked += remaining;
      rateSum += s.flowRate;
    } else if (s.status === 'Cancelled') {
      cancelled++;
    } else if (s.status === 'Completed') {
      completed++;
    }
  }

  const averageRate = activeCount > 0 ? rateSum / BigInt(activeCount) : 0n;

  return {
    totalStreams: streams.length,
    totalValueLocked,
    averageRate,
    statusBreakdown: {
      active: activeCount,
      cancelled,
      completed,
    },
  };
}

/**
 * Subscribes to claimable balance updates across multiple streams and emits the total sum.
 *
 * @param streams - List of streams to watch.
 * @param reconcileMapOrCb - Optional function/map returning claimable per stream or the total change callback.
 * @param onTotalChange - Callback invoked with the updated total claimable sum.
 * @param options - Optional WatchClaimableOptions.
 * @returns Unsubscribe function to stop watching all streams.
 */
export function watchTotalClaimable(
  streams: Stream[],
  reconcileMapOrCb?:
    | Array<() => Promise<bigint>>
    | ((streamId: string) => Promise<bigint>)
    | Record<string, () => Promise<bigint>>
    | ((total: bigint) => void),
  onTotalChange?: (total: bigint) => void,
  options?: WatchClaimableOptions,
): () => void {
  let callback: (total: bigint) => void;
  let reconcileFn: (stream: Stream, idx: number) => Promise<bigint>;

  if (Array.isArray(reconcileMapOrCb)) {
    // watchTotalClaimable(streams, [fn, fn, ...], onTotalChange)
    const arr = reconcileMapOrCb as Array<() => Promise<bigint>>;
    callback = onTotalChange ?? (() => {});
    reconcileFn = (s, idx) => (arr[idx] ? arr[idx]!() : Promise.resolve(claimableNow(s)));
  } else if (typeof reconcileMapOrCb === 'function' && !onTotalChange) {
    // watchTotalClaimable(streams, onTotalChange)
    callback = reconcileMapOrCb as (total: bigint) => void;
    reconcileFn = async (s) => claimableNow(s);
  } else if (typeof reconcileMapOrCb === 'function') {
    // watchTotalClaimable(streams, (streamId) => Promise<bigint>, onTotalChange)
    const fn = reconcileMapOrCb as (streamId: string) => Promise<bigint>;
    callback = onTotalChange!;
    reconcileFn = async (s) => fn(s.id);
  } else if (reconcileMapOrCb && typeof reconcileMapOrCb === 'object') {
    // watchTotalClaimable(streams, { streamId: () => Promise<bigint> }, onTotalChange)
    const map = reconcileMapOrCb as Record<string, () => Promise<bigint>>;
    callback = onTotalChange!;
    reconcileFn = async (s) => (map[s.id] ? map[s.id]!() : claimableNow(s));
  } else {
    callback = onTotalChange ?? (() => {});
    reconcileFn = async (s) => claimableNow(s);
  }

  if (streams.length === 0) {
    callback(0n);
    return () => {};
  }

  const values: Map<string, bigint> = new Map();
  for (const s of streams) {
    values.set(s.id, claimableNow(s));
  }

  let lastTotal: bigint | null = null;

  function calculateAndEmitTotal() {
    let sum = 0n;
    for (const val of values.values()) {
      sum += val;
    }
    if (sum !== lastTotal) {
      lastTotal = sum;
      callback(sum);
    }
  }

  if (Array.isArray(reconcileMapOrCb)) {
    // Suppress initial watchClaimable emissions until the reconcile phase is
    // done so that the first callback invocation reflects reconcile values,
    // not the zero-or-stale claimableNow values.
    let initialDone = false;

    const unsubscribes: Array<() => void> = [];
    for (let idx = 0; idx < streams.length; idx++) {
      const stream = streams[idx]!;
      unsubscribes.push(
        watchClaimable(
          stream,
          () => reconcileFn(stream, idx),
          (val) => {
            values.set(stream.id, val);
            if (initialDone) calculateAndEmitTotal();
          },
          options,
        ),
      );
    }

    let pending = streams.length;
    for (let idx = 0; idx < streams.length; idx++) {
      const stream = streams[idx]!;
      reconcileFn(stream, idx).then((val) => {
        values.set(stream.id, val);
        if (--pending === 0) {
          initialDone = true;
          calculateAndEmitTotal();
        }
      });
    }

    return () => {
      for (const unsub of unsubscribes) unsub();
    };
  } else {
    calculateAndEmitTotal();
  }

  const unsubscribes = streams.map((stream, idx) => {
    return watchClaimable(
      stream,
      () => reconcileFn(stream, idx),
      (val) => {
        values.set(stream.id, val);
        calculateAndEmitTotal();
      },
      options,
    );
  });

  return () => {
    for (const unsub of unsubscribes) {
      unsub();
    }
  };
}

/**
 * Breaks down a set of streams by their status (Active, Cancelled, Completed).
 *
 * @param streams - Stream list.
 * @returns Per-status counts.
 */
export function aggregateStreamsByStatus(streams: Stream[]): StatusBreakdown {
  let active = 0;
  let cancelled = 0;
  let completed = 0;

  for (const s of streams) {
    if (s.status === 'Active') active++;
    else if (s.status === 'Cancelled') cancelled++;
    else if (s.status === 'Completed') completed++;
  }

  return { active, cancelled, completed };
}

/**
 * Computes duration statistics (average, min, max, median) for a set of streams.
 * Durations are calculated as `endTime - startTime` for each stream.
 *
 * @param streams - Stream list.
 * @returns Duration statistics in seconds.
 */
export function averageStreamDuration(streams: Stream[]): DurationStats {
  if (streams.length === 0) {
    return { average: 0, min: 0, max: 0, median: 0 };
  }

  const durations = streams.map((s) => Math.max(0, s.endTime - s.startTime)).sort((a, b) => a - b);

  const sum = durations.reduce((a, b) => a + b, 0);
  const mid = Math.floor(durations.length / 2);

  return {
    average: Math.round(sum / durations.length),
    min: durations[0]!,
    max: durations[durations.length - 1]!,
    median:
      durations.length % 2 === 0
        ? Math.round((durations[mid - 1]! + durations[mid]!) / 2)
        : durations[mid]!,
  };
}

/**
 * Generates a health report for a set of streams, counting how many are
 * expiring, stalled, or underfunded.
 *
 * @param streams - Stream list.
 * @param expiringThresholdSeconds - Seconds threshold for expiry (default 86400 = 24h).
 * @param staleThresholdSeconds - Seconds since last withdraw for stall (default 604800 = 7d).
 * @returns Health report.
 */
export function streamHealthSummary(
  streams: Stream[],
  expiringThresholdSeconds = 86400,
  staleThresholdSeconds = 604800,
): StreamHealthReport {
  let expiring = 0;
  let stalled = 0;
  let underfunded = 0;
  let totalActive = 0;

  for (const s of streams) {
    if (s.status !== 'Active') continue;
    totalActive++;
    if (isStreamExpiring(s, expiringThresholdSeconds)) expiring++;
    if (isStreamStalled(s, staleThresholdSeconds)) stalled++;
    if (isStreamUnderfunded(s)) underfunded++;
  }

  return { expiring, stalled, underfunded, totalActive };
}

/**
 * Groups streams by recipient address and returns per-recipient aggregates.
 *
 * @param streams - Stream list.
 * @returns Per-recipient aggregates sorted by deposited amount descending.
 */
export function aggregateStreamsByRecipient(streams: Stream[]): RecipientAggregate[] {
  const map = new Map<string, RecipientAggregate>();

  for (const s of streams) {
    const existing = map.get(s.recipient) ?? {
      recipient: s.recipient,
      streamCount: 0,
      deposited: 0n,
      claimable: 0n,
      claimedSoFar: 0n,
    };
    existing.streamCount += 1;
    existing.deposited += s.deposit;
    existing.claimable += claimableNow(s);
    const claimed = s.deposit - s.flowRate * BigInt(s.endTime - s.lastWithdrawTime);
    existing.claimedSoFar += claimed > 0n ? claimed : 0n;
    map.set(s.recipient, existing);
  }

  return [...map.values()].sort((a, b) => {
    if (b.deposited > a.deposited) return 1;
    if (b.deposited < a.deposited) return -1;
    return 0;
  });
}

/**
 * Parses a CSV string into BulkStreamRow objects.
 *
 * Expected CSV format (header required):
 * ```
 * recipient,amount,durationSeconds
 * GABCD...1,10000000,2592000
 * GABCD...2,5000000,604800
 * ```
 *
 * `amount` is in stroops (bigint-compatible string).
 *
 * @param csv - The CSV content with header row.
 * @returns Parsed rows.
 */
export function parseCsvStreamRows(csv: string): BulkStreamRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  const header = lines[0]!.toLowerCase().trim();
  const cols = header.split(',').map((c) => c.trim());

  const recipientIdx = cols.indexOf('recipient');
  const amountIdx = cols.indexOf('amount');
  const durationIdx = cols.indexOf('durationseconds');
  const tokenIdx = cols.indexOf('token');

  if (recipientIdx === -1) throw new Error("CSV missing 'recipient' column");
  if (amountIdx === -1) throw new Error("CSV missing 'amount' column");
  if (durationIdx === -1) throw new Error("CSV missing 'durationSeconds' column");

  const rows: BulkStreamRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const fields = line.split(',').map((f) => f.trim());

    const recipient = fields[recipientIdx];
    if (!recipient) throw new Error(`Row ${i + 1}: missing recipient`);

    const amount = BigInt(fields[amountIdx] ?? '');
    const durationSeconds = Number(fields[durationIdx] ?? '0');

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`Row ${i + 1}: invalid durationSeconds`);
    }

    const row: BulkStreamRow = { recipient, amount, durationSeconds };
    if (tokenIdx !== -1 && fields[tokenIdx]) {
      row.token = fields[tokenIdx];
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Returns the safe maximum number of operations per Soroban transaction.
 *
 * Soroban imposes resource limits (CPU instructions, memory, read/write
 * ledger bytes) that constrain how many contract calls fit in a single
 * transaction. The default safe limit is **8** operations; pass a lower
 * value when your operations are heavier than average (e.g. large `topUp`
 * payloads), or a higher value only after profiling against your specific
 * workload.
 *
 * @param custom - Optional override. Must be a positive integer ≤ 25.
 * @returns The resolved safe batch size.
 *
 * @example
 * ```ts
 * // Use the default safe limit
 * const size = batchSize();          // 8
 *
 * // Override for lighter operations
 * const size = batchSize(12);        // 12
 *
 * // Chunk a large list yourself
 * const ids = await client.getStreamsByRecipient(recipient);
 * for (let i = 0; i < ids.length; i += batchSize()) {
 *   await client.batchWithdraw(ids.slice(i, i + batchSize()));
 * }
 * ```
 */
export function batchSize(custom?: number): number {
  const DEFAULT = 8;
  const MAX = 25;
  if (custom === undefined) return DEFAULT;
  if (!Number.isInteger(custom) || custom <= 0 || custom > MAX) {
    throw new SoroStreamError(`batchSize must be a positive integer ≤ ${MAX}, got ${custom}`);
  }
  return custom;
}

/**
 * Recursively converts BigInt properties in an object to strings,
 * allowing safe serialization with JSON.stringify.
 *
 * Useful for logging or exporting stream objects, vesting schedules,
 * and aggregate totals that include BigInt fields like flowRate,
 * totalAmount, or claimableAmount.
 *
 * @param obj - The object containing BigInt fields.
 * @returns A plain object with all BigInt fields converted to string.
 */
export function streamToJSON(obj: unknown): unknown {
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(streamToJSON);
  }
  if (obj !== null && typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'toJSON') continue;
      res[key] = streamToJSON(value);
    }
    return res;
  }
  return obj;
}

/**
 * Helper function to serialize objects containing BigInt fields to JSON strings.
 * Automatically converts BigInt fields (like flowRate, totalAmount, claimableAmount) to strings.
 *
 * @param obj - The object to serialize.
 * @param space - Optional indentation space for pretty-printing.
 * @returns The JSON string representation.
 */
export function jsonStringifyStream(obj: unknown, space?: string | number): string {
  return JSON.stringify(
    obj,
    (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    space,
  );
}

export const jsonStringify = jsonStringifyStream;

// ── Issue #226: String field length validation ────────────────────────────────

/**
 * Maximum byte length limits for string fields passed to the contract.
 * Keys match the field names used in `CreateStreamParams` and related types.
 *
 * @example
 * ```ts
 * import { STRING_FIELD_LIMITS } from "@sorostream/sdk";
 * const limit = STRING_FIELD_LIMITS.recipient; // 64
 * ```
 */
export const STRING_FIELD_LIMITS: Readonly<Record<string, number>> = {
  recipient: 64,
  token: 64,
  metadataUri: 128,
  description: 256,
};

/**
 * Validates that a string field does not exceed its allowed byte length.
 * Throws {@link SoroStreamValidationError} when the limit is exceeded.
 *
 * @param field - Field name (must be a key in `STRING_FIELD_LIMITS`).
 * @param value - The string value to validate.
 * @throws {SoroStreamValidationError} When the byte length exceeds the limit.
 *
 * @example
 * ```ts
 * validateStringLength("recipient", params.recipient);
 * validateStringLength("metadataUri", metadataUri); // 128 byte limit
 * ```
 */
export function validateStringLength(field: string, value: string): void {
  const limit = STRING_FIELD_LIMITS[field];
  if (limit === undefined) return; // no configured limit — pass through
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength > limit) {
    throw new SoroStreamValidationError(field, byteLength, limit);
  }
}

const BIGINT_SUFFIX = '_bigint';

/**
 * Custom JSON.stringify replacer that serializes BigInt values as strings
 * with a `_bigint` suffix, enabling round-trip-safe serialization.
 *
 * Use this as the `replacer` argument to `JSON.stringify` when serializing
 * objects that contain BigInt fields:
 *
 * @example
 * ```ts
 * const json = JSON.stringify(stream, bigintReplacer);
 * ```
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()}${BIGINT_SUFFIX}` : value;
}

/**
 * Custom JSON.parse reviver that restores `_bigint`-suffixed strings back to
 * BigInt values. Intended to reverse {@link bigintReplacer}.
 *
 * @example
 * ```ts
 * const obj = JSON.parse(json, bigintReviver);
 * ```
 */
export function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.endsWith(BIGINT_SUFFIX)) {
    const raw = value.slice(0, -BIGINT_SUFFIX.length);
    try {
      return BigInt(raw);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Serializes a {@link Stream} object to a JSON string, handling BigInt fields
 * (deposit, flowRate) via the `_bigint` suffix convention for round-trip safety.
 *
 * Use {@link deserializeStreamFromJSON} to restore the stream object.
 *
 * Plain `JSON.stringify(stream)` throws `TypeError: Do not know how to serialize a BigInt`
 * because BigInt values are not JSON-serializable by default. Always use this
 * utility (or {@link bigintReplacer}) when serializing stream objects.
 *
 * @param stream - The stream object to serialize.
 * @param space - Optional indentation for pretty-printing.
 * @returns A JSON string with BigInt fields serialised as `"<value>_bigint"`.
 *
 * @example
 * ```ts
 * const json = serializeStreamToJSON(stream);
 * const restored = deserializeStreamFromJSON(json);
 * ```
 */
export function serializeStreamToJSON(
  stream: import('./types.js').Stream,
  space?: string | number,
): string {
  return JSON.stringify(stream, bigintReplacer, space);
}

/**
 * Deserializes a JSON string (produced by {@link serializeStreamToJSON}) back
 * into a {@link Stream} object, restoring BigInt fields from their `_bigint`-
 * suffixed string representation.
 *
 * @param json - The JSON string to deserialize.
 * @returns The restored Stream object.
 * @throws {Error} If the JSON cannot be parsed or does not contain valid stream fields.
 *
 * @example
 * ```ts
 * const json = serializeStreamToJSON(stream);
 * const restored = deserializeStreamFromJSON(json);
 * console.log(restored.deposit); // BigInt
 * ```
 */
export function deserializeStreamFromJSON(json: string): import('./types.js').Stream {
  const parsed = JSON.parse(json, bigintReviver) as Record<string, unknown>;

  const id = String(parsed['id'] ?? '');
  if (!id) throw new Error("deserializeStreamFromJSON: missing 'id' field");

  const deposit =
    typeof parsed['deposit'] === 'bigint'
      ? (parsed['deposit'] as bigint)
      : BigInt(String(parsed['deposit'] ?? '0'));
  const flowRate =
    typeof parsed['flowRate'] === 'bigint'
      ? (parsed['flowRate'] as bigint)
      : BigInt(String(parsed['flowRate'] ?? '0'));

  const stream: import('./types.js').Stream = {
    id,
    sender: String(parsed['sender'] ?? ''),
    recipient: String(parsed['recipient'] ?? ''),
    token: String(parsed['token'] ?? ''),
    deposit,
    flowRate,
    startTime: Number(parsed['startTime'] ?? 0),
    endTime: Number(parsed['endTime'] ?? 0),
    lastWithdrawTime: Number(parsed['lastWithdrawTime'] ?? 0),
    status: (parsed['status'] as import('./types.js').Stream['status']) ?? 'Active',
    autoRenew: Boolean(parsed['autoRenew']),
    ...(parsed['pausedAt'] != null ? { pausedAt: Number(parsed['pausedAt']) } : {}),
    ...(parsed['lockUntil'] != null ? { lockUntil: Number(parsed['lockUntil']) } : {}),
  };

  return stream;
}

// ── Stream ID encoding / decoding (base58, URL-safe) ──────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET[i]!] = i;
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Encodes a bigint stream ID as a URL-safe base58 string.
 *
 * @param id - A non-negative bigint fitting in a u64 (0 … 2^64-1).
 * @returns A base58-encoded string using the alphanumeric alphabet.
 * @throws {RangeError} If `id` is negative or exceeds u64 range.
 */
export function encodeStreamId(id: bigint): string {
  if (id < 0n || id > U64_MAX) {
    throw new RangeError(
      `encodeStreamId: id must be in range 0..${U64_MAX.toString()}, got ${id.toString()}`,
    );
  }
  if (id === 0n) return '1';
  let n = id;
  let result = '';
  while (n > 0n) {
    const remainder = Number(n % 58n);
    n = n / 58n;
    result = BASE58_ALPHABET[remainder]! + result;
  }
  return result;
}

/**
 * Decodes a base58-encoded stream ID string back to a bigint.
 *
 * @param encoded - A base58-encoded string.
 * @returns The decoded bigint value.
 * @throws {RangeError} If the decoded value exceeds u64 range.
 * @throws {Error} If the string is empty or contains invalid base58 characters.
 */
export function decodeStreamId(encoded: string): bigint {
  if (encoded.length === 0) {
    throw new Error('decodeStreamId: empty string');
  }
  let result = 0n;
  for (const ch of encoded) {
    const digit = BASE58_MAP[ch];
    if (digit === undefined) {
      throw new Error(`decodeStreamId: invalid base58 character '${ch}'`);
    }
    result = result * 58n + BigInt(digit);
  }
  if (result > U64_MAX) {
    throw new RangeError(`decodeStreamId: decoded value exceeds u64 range`);
  }
  return result;
}

/**
 * Validates and parses a caller-supplied stream ID string before it is
 * converted to a `BigInt` and sent in a contract call (issue #458).
 *
 * Rejects anything that is not a plain non-negative decimal integer within
 * u64 range, so malformed input (empty string, whitespace, signs, non-digit
 * characters, oversized values) fails at the SDK boundary with a clear
 * error instead of a raw `BigInt` `SyntaxError` or an opaque contract
 * rejection.
 *
 * @throws {InvalidStreamIdError} If `streamId` is not a valid u64 decimal string.
 */
export function parseStreamId(streamId: string): bigint {
  if (typeof streamId !== 'string' || !/^(0|[1-9]\d*)$/.test(streamId)) {
    throw new InvalidStreamIdError(streamId);
  }
  const value = BigInt(streamId);
  if (value > U64_MAX) {
    throw new InvalidStreamIdError(streamId);
  }
  return value;
}

// ── Memo parsing ─────────────────────────────────────────────────────────

/**
 * Parses a raw memo value (from a JSON/JS object) into a Stellar Memo object.
 * Accepts string (text), hex string (hash), or null/undefined (none).
 *
 * Issue #406: Replaced `require('@stellar/stellar-sdk')` dynamic call and
 * `Buffer.from(value, 'hex')` with a static import. The 64-char hex string
 * is passed directly to `Memo.hash()` which accepts hex natively, keeping
 * this function free of Node.js Buffer APIs and safe in Cloudflare Workers.
 *
 * @param value - The raw memo value.
 * @returns A Stellar Memo object, or Memo-none if null/undefined.
 */
export function parseMemo(value: string | null | undefined): import('@stellar/stellar-sdk').Memo {
  if (value == null || value === '') return Memo.none();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    // Stellar SDK's Memo.hash accepts a 64-char hex string directly —
    // no Buffer required, works in all environments including CF Workers.
    return Memo.hash(value);
  }
  return Memo.text(value);
}

// ── Issue #398: getStreamHealth ──────────────────────────────────────────────

/**
 * Returns a health score (0–100) and status string for a stream based on its
 * remaining balance, elapsed time, and last withdrawal timestamp.
 *
 * Scoring rules:
 * - **100** — stream is healthy: on track, no stall, no underfunding.
 * - **60–99** — warning: stalled (no recent withdrawal) or > 90 % elapsed with
 *   balance remaining.
 * - **0–59** — critical: severely stalled, near-drained, or underfunded.
 * - **"completed"** — stream has ended and `status === 'Completed'`.
 * - **"cancelled"** — stream has `status === 'Cancelled'`.
 *
 * @param stream - The stream to evaluate.
 * @param now - Optional override for "now" in Unix seconds (default: `Date.now() / 1000`).
 * @returns A {@link StreamHealthResult} with numeric score and diagnostic messages.
 *
 * @example
 * ```ts
 * import { getStreamHealth } from '@sorostream/sdk';
 *
 * const health = getStreamHealth(stream);
 * if (health.status === 'critical') {
 *   console.warn(`Stream is at risk: ${health.diagnostics.join(', ')}`);
 * }
 * ```
 */
export function getStreamHealth(stream: Stream, now?: number): StreamHealthResult {
  const nowSecs = now ?? Math.floor(Date.now() / 1000);
  const diagnostics: string[] = [];

  // ── Terminal states ──────────────────────────────────────────────────────
  if (stream.status === 'Cancelled') {
    return {
      score: 0,
      status: 'cancelled',
      remainingBalance: 0n,
      elapsedSeconds: 0,
      remainingSeconds: 0,
      secondsSinceLastWithdrawal: 0,
      diagnostics: ['Stream has been cancelled'],
    };
  }

  if (stream.status === 'Completed') {
    return {
      score: 100,
      status: 'completed',
      remainingBalance: 0n,
      elapsedSeconds: stream.endTime - stream.startTime,
      remainingSeconds: 0,
      secondsSinceLastWithdrawal: Math.max(0, nowSecs - stream.lastWithdrawTime),
      diagnostics: [],
    };
  }

  // ── Active / Paused ──────────────────────────────────────────────────────
  const duration = stream.endTime - stream.startTime;
  const elapsedSeconds = Math.max(0, Math.min(nowSecs - stream.startTime, duration));
  const remainingSeconds = Math.max(0, stream.endTime - nowSecs);

  // Remaining balance = deposit − (flowRate × elapsed since start, capped at deposit)
  const streamedSoFar = stream.flowRate * BigInt(elapsedSeconds);
  const remainingBalance =
    stream.deposit > streamedSoFar ? stream.deposit - streamedSoFar : 0n;

  const secondsSinceLastWithdrawal =
    stream.lastWithdrawTime > 0 ? Math.max(0, nowSecs - stream.lastWithdrawTime) : 0;

  // ── Scoring ──────────────────────────────────────────────────────────────
  let score = 100;

  // Check for stall: recipient hasn't withdrawn in > 10 % of stream duration
  const stallThreshold = Math.max(60, Math.floor(duration * 0.1));
  const isStalled =
    stream.lastWithdrawTime > 0 && secondsSinceLastWithdrawal > stallThreshold;
  if (isStalled) {
    const penalty = Math.min(40, Math.floor((secondsSinceLastWithdrawal / stallThreshold) * 20));
    score -= penalty;
    diagnostics.push(
      `No withdrawal in ${secondsSinceLastWithdrawal}s (stall threshold: ${stallThreshold}s)`,
    );
  }

  // Check underfunding: remaining balance can't cover what's left to stream
  const remainingToStream = stream.flowRate * BigInt(remainingSeconds);
  const isUnderfunded = remainingBalance < remainingToStream;
  if (isUnderfunded) {
    score -= 30;
    diagnostics.push(
      `Underfunded: remaining balance (${remainingBalance}) < remaining payout (${remainingToStream})`,
    );
  }

  // Check near-expiry with balance: > 90 % elapsed but balance still locked
  const elapsedFraction = duration > 0 ? elapsedSeconds / duration : 0;
  const nearExpiry = elapsedFraction > 0.9 && remainingBalance > 0n && remainingSeconds > 0;
  if (nearExpiry) {
    score -= 10;
    diagnostics.push(`Stream is > 90% complete with ${remainingBalance} stroops still locked`);
  }

  score = Math.max(0, score);

  let status: StreamHealthResult['status'];
  if (score >= 80) {
    status = 'healthy';
  } else if (score >= 50) {
    status = 'warning';
  } else {
    status = 'critical';
  }

  return {
    score,
    status,
    remainingBalance,
    elapsedSeconds,
    remainingSeconds,
    secondsSinceLastWithdrawal,
    diagnostics,
  };
}
