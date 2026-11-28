import { describe, expect, it, vi } from 'vitest';
import {
  isSoroStreamError,
  isNetworkError,
  isContractError,
  isValidationError,
  isAuthError,
  matchError,
} from '../src/error-guards.js';
import {
  SoroStreamError,
  SoroStreamRetryExhaustedError,
  FederationResolutionError,
  TransactionFailedError,
  StreamNotFoundError,
  StreamNotActiveError,
  DuplicateStreamError,
  BulkCreatePartialError,
  InsufficientAmountError,
  InsufficientBalanceError,
  InsufficientAllowanceError,
  ZeroDurationError,
  InvalidAddressError,
  AccountNotFoundError,
  SoroStreamValidationError,
  SoroStreamMemoError,
  NonceNotSupportedError,
  SoroStreamDependencyError,
  StartTimeInPastError,
  InvalidStreamIdError,
  TransactionMutatedError,
} from '../src/errors.js';

const ADDRESS = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

// One instance of every error class, grouped by the category the guards use.
const networkErrors: Error[] = [
  new SoroStreamRetryExhaustedError(new Error('boom'), 3, [], null),
  new FederationResolutionError(ADDRESS, 'not found'),
];

const contractErrors: Error[] = [
  new TransactionFailedError('tx failed'),
  new StreamNotFoundError('42'),
  new StreamNotActiveError('42'),
  new DuplicateStreamError(),
  new BulkCreatePartialError([], []),
];

const validationErrors: Error[] = [
  new InsufficientAmountError(),
  new InsufficientBalanceError(),
  new InsufficientAllowanceError('TOKEN', 10n, 5n),
  new ZeroDurationError(),
  new InvalidAddressError('not-an-address'),
  new AccountNotFoundError(ADDRESS),
  new SoroStreamValidationError('memo', 40, 28),
  new SoroStreamMemoError('memo too long'),
  new StartTimeInPastError(1_000, 2_000),
  new InvalidStreamIdError('abc'),
];

const authErrors: Error[] = [
  new NonceNotSupportedError(),
  new SoroStreamDependencyError('@sorostream/sdk', '^2.0.0', '1.0.0'),
  new TransactionMutatedError(),
];

// A plain Error and a bare SoroStreamError are outside every category.
const uncategorisedErrors: unknown[] = [new Error('plain error'), new SoroStreamError('base')];

type Guard = (err: unknown) => boolean;

const categories: Array<{ name: string; guard: Guard; matching: Error[]; others: Error[][] }> = [
  {
    name: 'isNetworkError',
    guard: isNetworkError,
    matching: networkErrors,
    others: [contractErrors, validationErrors, authErrors],
  },
  {
    name: 'isContractError',
    guard: isContractError,
    matching: contractErrors,
    others: [networkErrors, validationErrors, authErrors],
  },
  {
    name: 'isValidationError',
    guard: isValidationError,
    matching: validationErrors,
    others: [networkErrors, contractErrors, authErrors],
  },
  {
    name: 'isAuthError',
    guard: isAuthError,
    matching: authErrors,
    others: [networkErrors, contractErrors, validationErrors],
  },
];

describe('isSoroStreamError', () => {
  it('returns true for every error class in the hierarchy', () => {
    const all = [...networkErrors, ...contractErrors, ...validationErrors, ...authErrors];
    for (const err of all) {
      expect(isSoroStreamError(err), err.constructor.name).toBe(true);
    }
    expect(isSoroStreamError(new SoroStreamError('base'))).toBe(true);
  });

  it('returns false for errors outside the SoroStream hierarchy', () => {
    expect(isSoroStreamError(new Error('plain error'))).toBe(false);
    expect(isSoroStreamError('not an error')).toBe(false);
    expect(isSoroStreamError(undefined)).toBe(false);
  });
});

describe.each(categories)('$name', ({ guard, matching, others }) => {
  it('returns true for every error class it claims to match', () => {
    for (const err of matching) {
      expect(guard(err), err.constructor.name).toBe(true);
    }
  });

  it('returns false for errors from other categories', () => {
    for (const group of others) {
      for (const err of group) {
        expect(guard(err), err.constructor.name).toBe(false);
      }
    }
  });

  it('returns false for a plain Error and a bare SoroStreamError', () => {
    for (const err of uncategorisedErrors) {
      expect(guard(err)).toBe(false);
    }
  });

  it('returns false for non-error values', () => {
    expect(guard(null)).toBe(false);
    expect(guard(undefined)).toBe(false);
    expect(guard('error')).toBe(false);
  });
});

describe('matchError', () => {
  it('dispatches each error category to its corresponding handler', () => {
    const network = new SoroStreamRetryExhaustedError(new Error('retry exhausted'), 3, [], null);
    const contract = new TransactionFailedError('tx failed');
    const validation = new InsufficientAmountError();
    const auth = new NonceNotSupportedError();

    const onNetwork = vi.fn(() => 'network');
    const onContract = vi.fn(() => 'contract');
    const onValidation = vi.fn(() => 'validation');
    const onAuth = vi.fn(() => 'auth');
    const otherwise = vi.fn(() => 'otherwise');

    expect(matchError(network, { onNetwork, onContract, onValidation, onAuth, otherwise })).toBe(
      'network',
    );
    expect(matchError(contract, { onNetwork, onContract, onValidation, onAuth, otherwise })).toBe(
      'contract',
    );
    expect(matchError(validation, { onNetwork, onContract, onValidation, onAuth, otherwise })).toBe(
      'validation',
    );
    expect(matchError(auth, { onNetwork, onContract, onValidation, onAuth, otherwise })).toBe(
      'auth',
    );

    expect(onNetwork).toHaveBeenCalledTimes(1);
    expect(onContract).toHaveBeenCalledTimes(1);
    expect(onValidation).toHaveBeenCalledTimes(1);
    expect(onAuth).toHaveBeenCalledTimes(1);
    expect(otherwise).not.toHaveBeenCalled();
  });

  it('dispatches in fixed order onNetwork → onContract → onValidation → onAuth → otherwise', () => {
    const err = new SoroStreamRetryExhaustedError(new Error('retry exhausted'), 3, [], null);

    const onNetwork = vi.fn(() => 'network');
    const onContract = vi.fn(() => 'contract');
    const onValidation = vi.fn(() => 'validation');
    const onAuth = vi.fn(() => 'auth');
    const otherwise = vi.fn(() => 'otherwise');

    const result = matchError(err, { onNetwork, onContract, onValidation, onAuth, otherwise });

    expect(result).toBe('network');
    expect(onNetwork).toHaveBeenCalledTimes(1);
    expect(onNetwork).toHaveBeenCalledWith(err);
    expect(onContract).not.toHaveBeenCalled();
    expect(onValidation).not.toHaveBeenCalled();
    expect(onAuth).not.toHaveBeenCalled();
    expect(otherwise).not.toHaveBeenCalled();
  });

  it('falls back to otherwise when no category matches', () => {
    const err = new Error('plain error');
    const otherwise = vi.fn(() => 'otherwise');

    expect(matchError(err, { otherwise })).toBe('otherwise');
    expect(otherwise).toHaveBeenCalledWith(err);
  });

  it('returns undefined when no handler matches and otherwise is omitted', () => {
    const err = new Error('plain error');

    expect(matchError(err, {})).toBeUndefined();
    expect(
      matchError(err, {
        onNetwork: () => 'network',
        onContract: () => 'contract',
        onValidation: () => 'validation',
        onAuth: () => 'auth',
      }),
    ).toBeUndefined();
  });

  it('supports the documented early-exit example with omitted handlers', () => {
    const onNetwork = vi.fn(() => 'network');
    const onValidation = vi.fn(() => 'validation');

    const network = new SoroStreamRetryExhaustedError(new Error('retry exhausted'), 3, [], null);
    const validation = new InsufficientAmountError();
    const unmatched = new TransactionFailedError('tx failed');

    expect(matchError(network, { onNetwork, onValidation })).toBe('network');
    expect(matchError(validation, { onNetwork, onValidation })).toBe('validation');
    expect(matchError(unmatched, { onNetwork, onValidation })).toBeUndefined();

    expect(onNetwork).toHaveBeenCalledTimes(1);
    expect(onValidation).toHaveBeenCalledTimes(1);
  });
});
