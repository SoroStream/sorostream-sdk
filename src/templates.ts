import type { CreateStreamParams } from './types.js';

const DAY = 86_400;
const WEEK = 604_800;

function days(n: number): number {
  return n * DAY;
}

/**
 * Token classes a template can branch on when resolving a conditional
 * parameter (issue #710). Open string so callers may pass registry labels.
 */
export type TemplateTokenType = 'native' | 'stablecoin' | 'volatile' | (string & {});

/** Context passed to conditional template parameters at instantiation (issue #710). */
export interface TemplateTokenContext {
  /** The token type the template is being instantiated with. */
  tokenType: TemplateTokenType;
  /** Decimals of that token (default 7, the Stellar asset standard). */
  decimals: number;
}

/**
 * Map of conditional branches keyed by token type, with an optional default fallback (issue #791).
 */
export type ConditionalBranchMap<T> = Partial<Record<TemplateTokenType, T>> & {
  default?: T;
};

/**
 * A template parameter that is either a static value (existing behaviour),
 * a resolver evaluated at instantiation time with the token context, or
 * a dictionary of branches by token type with a default fallback (issue #710, #791).
 */
export type ConditionalParam<T> =
  | T
  | ((ctx: TemplateTokenContext) => T)
  | ConditionalBranchMap<T>;

/**
 * Helper to construct a conditional parameter branch map with an explicit fallback default (issue #791).
 */
export function conditionalByTokenType<T>(
  branches: Partial<Record<TemplateTokenType, T>>,
  fallbackDefault?: T,
): ConditionalBranchMap<T> {
  return {
    ...branches,
    ...(fallbackDefault !== undefined ? { default: fallbackDefault } : {}),
  };
}

/**
 * Resolves a {@link ConditionalParam}: static values pass through unchanged,
 * functions are invoked with the instantiation context, and branch maps
 * return the matching branch or fallback default (issue #710, #791).
 *
 * If an unrecognized token type has no branch defined and no default is present,
 * a descriptive error is thrown naming the unhandled token type.
 */
export function resolveConditionalParam<T>(
  value: ConditionalParam<T>,
  ctx: TemplateTokenContext,
  fallback?: T,
): T {
  if (typeof value === 'function') {
    const result = (value as (ctx: TemplateTokenContext) => T)(ctx);
    if (result === undefined && fallback !== undefined) {
      return fallback;
    }
    return result;
  }

  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { byteLength?: unknown }).byteLength !== 'number'
  ) {
    const branches = value as ConditionalBranchMap<T>;
    if (ctx.tokenType in branches && branches[ctx.tokenType] !== undefined) {
      return branches[ctx.tokenType]!;
    }
    if (branches.default !== undefined) {
      return branches.default;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(
      `Unhandled token type "${ctx.tokenType}" in conditional template parameter. Defined branches: ${Object.keys(
        branches,
      ).join(', ')}`,
    );
  }

  return value as T;
}

/**
 * Pre-built stream templates that produce ready-to-use CreateStreamParams,
 * reducing boilerplate for common stream configurations.
 *
 * @example
 * ```ts
 * // Biweekly payroll: streams for 2 weeks
 * const params = templates.biweeklyPayroll({
 *   recipient: "G…",
 *   token: "GUSDC…",
 *   amount: toStroops("5000"),
 *   autoRenew: true,
 * });
 * const { streamId } = await client.createStream(params);
 * ```
 */
export const templates = {
  /**
   * Creates a biweekly (14-day) payroll stream.
   */
  biweeklyPayroll(params: Omit<CreateStreamParams, 'durationSeconds'>): CreateStreamParams {
    return { ...params, durationSeconds: days(14) };
  },

  /**
   * Creates a weekly (7-day) stream.
   */
  weekly(params: Omit<CreateStreamParams, 'durationSeconds'>): CreateStreamParams {
    return { ...params, durationSeconds: WEEK };
  },

  /**
   * Creates a monthly (30-day) stream.
   */
  monthly(params: Omit<CreateStreamParams, 'durationSeconds'>): CreateStreamParams {
    return { ...params, durationSeconds: days(30) };
  },

  /**
   * Creates a fixed-term vesting stream spanning a given number of years.
   * @param params.years - Number of years for the vesting period.
   */
  vesting(
    params: Omit<CreateStreamParams, 'durationSeconds'> & { years: number },
  ): CreateStreamParams {
    return { ...params, durationSeconds: days(365 * params.years) };
  },

  /**
   * Creates a custom-duration stream for a given number of days.
   */
  custom(
    params: Omit<CreateStreamParams, 'durationSeconds'> & { days: number },
  ): CreateStreamParams {
    return { ...params, durationSeconds: days(params.days) };
  },

  /**
   * Creates a stream whose initial amount is a token-type-conditional
   * parameter, resolved at instantiation time from the given token type and
   * decimals (issue #710, #791). Static `amount` values keep working unchanged.
   *
   * @example
   * ```ts
   * const params = templates.minAmountStream({
   *   recipient: "G…", token: "GUSDC…", autoRenew: false,
   *   tokenType: "stablecoin", decimals: 6,
   *   amount: (ctx) => 10n ** BigInt(ctx.decimals), // 1 unit minimum
   *   defaultAmount: 1_000_000n, // Fallback default if token type is unhandled
   * });
   * ```
   */
  minAmountStream(
    params: Omit<CreateStreamParams, 'amount'> & {
      amount: ConditionalParam<bigint>;
      tokenType: TemplateTokenType;
      decimals?: number;
      defaultAmount?: bigint;
    },
  ): CreateStreamParams {
    const { tokenType, decimals = 7, amount, defaultAmount, ...rest } = params;
    return {
      ...rest,
      amount: resolveConditionalParam(amount, { tokenType, decimals }, defaultAmount),
    };
  },
};
