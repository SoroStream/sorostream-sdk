import type { CreateStreamParams } from './types.js';

const DAY = 86_400;
const WEEK = 604_800;

function days(n: number): number {
  return n * DAY;
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
};
