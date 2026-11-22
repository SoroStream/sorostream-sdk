/**
 * Tests for issues #752, #753, #754, #755.
 *
 * #752 – RateLimitExceededError structured fields (suggestedRetryAfterMs)
 *        → see write_rate_limiter.test.ts for the full suite; the new field
 *          is covered there alongside the existing depth/limit assertions.
 *
 * #753 – requireAddress: opt-in on-chain existence check via Horizon
 * #755 – addressBook public entry point (import reachability smoke-test)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  requireAddressWithExistenceCheck,
  InvalidAddressError,
  AccountNotFoundError,
} from '../src/index.js';
// Issue #755: import via the dedicated subpath barrel — this is the import
// path a package consumer would use: `@sorostream/sdk/address-book`.
import {
  InMemoryAddressBook,
  PersistedAddressBook,
  AddressBookValidationError,
  AddressBookNotFoundError,
} from '../src/address-book.js';

// ── #753 ─────────────────────────────────────────────────────────────────────

const VALID_ADDRESS = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const MALFORMED_ADDRESS = 'NOT_A_REAL_ADDRESS';
const HORIZON = 'https://horizon-testnet.stellar.org';

afterEach(() => vi.restoreAllMocks());

describe('requireAddressWithExistenceCheck (#753)', () => {
  it('default requireAddress (format-only) is unaffected — synchronous, no fetch', async () => {
    // Import the synchronous function directly so we confirm it still works
    // without any network call.
    const { requireAddress } = await import('../src/contractEncoders.js');
    expect(requireAddress(VALID_ADDRESS)).toBe(VALID_ADDRESS);
    expect(() => requireAddress(MALFORMED_ADDRESS)).toThrow(InvalidAddressError);
  });

  it('rejects a malformed address before making any network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      requireAddressWithExistenceCheck(MALFORMED_ADDRESS, { horizonUrl: HORIZON }),
    ).rejects.toThrow(InvalidAddressError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves when Horizon returns 200 (account exists)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    await expect(
      requireAddressWithExistenceCheck(VALID_ADDRESS, { horizonUrl: HORIZON }),
    ).resolves.toBe(VALID_ADDRESS);
  });

  it('throws AccountNotFoundError when Horizon returns 404 (nonexistent address)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"status":404,"title":"Resource Missing"}', { status: 404 }),
    );
    await expect(
      requireAddressWithExistenceCheck(VALID_ADDRESS, { horizonUrl: HORIZON }),
    ).rejects.toThrow(AccountNotFoundError);
  });

  it('throws AccountNotFoundError when the network request itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      requireAddressWithExistenceCheck(VALID_ADDRESS, { horizonUrl: HORIZON }),
    ).rejects.toThrow(AccountNotFoundError);
  });

  it('throws a generic Error (not AccountNotFoundError) for unexpected non-404 HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    await expect(
      requireAddressWithExistenceCheck(VALID_ADDRESS, { horizonUrl: HORIZON }),
    ).rejects.toThrow(/HTTP 500/);
    // Must NOT be an AccountNotFoundError — that is reserved for 404 / network failure.
    try {
      await requireAddressWithExistenceCheck(VALID_ADDRESS, { horizonUrl: HORIZON });
    } catch (err) {
      expect(err).not.toBeInstanceOf(AccountNotFoundError);
    }
  });

  it('strips a trailing slash from horizonUrl before building the request URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    await requireAddressWithExistenceCheck(VALID_ADDRESS, {
      horizonUrl: 'https://horizon-testnet.stellar.org/',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://horizon-testnet.stellar.org/accounts/${VALID_ADDRESS}`,
    );
  });
});

// ── #755 ─────────────────────────────────────────────────────────────────────

const ALICE = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const BOB   = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

describe('addressBook subpath entry point (#755)', () => {
  it('InMemoryAddressBook is importable from src/address-book.ts', () => {
    // Confirms the subpath barrel re-exports the class successfully.
    expect(InMemoryAddressBook).toBeDefined();
    const book = new InMemoryAddressBook();
    expect(book).toBeInstanceOf(InMemoryAddressBook);
  });

  it('PersistedAddressBook is importable from src/address-book.ts', () => {
    expect(PersistedAddressBook).toBeDefined();
    const store: Record<string, string> = {};
    const book = new PersistedAddressBook({
      storage: {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
      },
    });
    expect(book).toBeInstanceOf(PersistedAddressBook);
  });

  it('AddressBookValidationError is importable and constructable', () => {
    expect(AddressBookValidationError).toBeDefined();
    const err = new AddressBookValidationError('alias', 'bad');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AddressBookValidationError');
  });

  it('AddressBookNotFoundError is importable and constructable', () => {
    expect(AddressBookNotFoundError).toBeDefined();
    const err = new AddressBookNotFoundError('nobody');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AddressBookNotFoundError');
  });

  it('core set/resolve round-trip works via the subpath import', () => {
    const book = new InMemoryAddressBook();
    book.set('alice', ALICE);
    expect(book.resolve('alice')).toBe(ALICE);
  });

  it('resolve passes through a raw address unchanged', () => {
    const book = new InMemoryAddressBook();
    expect(book.resolve(BOB)).toBe(BOB);
  });

  it('resolve throws AddressBookNotFoundError for an unknown alias', () => {
    const book = new InMemoryAddressBook();
    expect(() => book.resolve('unknown')).toThrow(AddressBookNotFoundError);
  });

  it('set throws AddressBookValidationError for a malformed address', () => {
    const book = new InMemoryAddressBook();
    expect(() => book.set('bad', 'NOT_AN_ADDRESS')).toThrow(AddressBookValidationError);
  });
});
