// Dependency-free helpers shared across modules. Keeping these in a leaf
// module avoids runtime import cycles (e.g. utils <-> errors).

/**
 * Redacts Stellar secret keys (S...), mnemonics, and private keys from strings and error messages (issue #525).
 *
 * @param input - The string to redact secret materials from.
 * @returns The redacted string with placeholders.
 */
export function redactSecretKey(input: string): string {
  if (!input) return input;
  let result = input.replace(/\bS[A-Z2-7]{55}\b/g, '[REDACTED_SECRET_KEY]');
  result = result.replace(
    /\b(secretKey|secretSeed|privateKey|mnemonic|secret|seed)\s*[:=]\s*["']?[^"'\s,]+["']?/gi,
    '$1=[REDACTED_SECRET]',
  );
  return result;
}

/**
 * Applies a ±25% jitter to a raw exponential backoff delay.
 *
 * Spreads retry load across a window so that clients recovering from a
 * transient outage do not all retry simultaneously (the "thundering herd"
 * problem). The jittered value is bounded to the raw delay:
 *   jittered ∈ [rawDelay × 0.75, rawDelay × 1.25]
 *
 * @param rawDelayMs - The capped exponential delay in ms.
 * @returns The jittered delay in ms, rounded down to an integer.
 */
export function jitterDelay(rawDelayMs: number): number {
  if (rawDelayMs <= 0) return 0;
  const jitter = rawDelayMs * 0.25;
  const min = rawDelayMs - jitter;
  const max = rawDelayMs + jitter;
  return Math.floor(min + Math.random() * (max - min));
}
