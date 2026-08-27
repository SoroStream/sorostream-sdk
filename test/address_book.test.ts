/**
 * Tests for Issue #394: In-memory and persisted address book API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InMemoryAddressBook,
  PersistedAddressBook,
  AddressBookValidationError,
  AddressBookNotFoundError,
} from '../src/addressBook.js';
import type { StorageAdapter } from '../src/adapters.js';

// Valid Stellar G-addresses used in tests
const ALICE = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const BOB   = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const CAROL = 'GAZ6TMAM2LER4Z6BVPB3VK6GFRAALRLL543HMZLMXZVRLM24MK6CDEAQ';

afterEach(() => vi.restoreAllMocks());

// ── InMemoryAddressBook ───────────────────────────────────────────────────

describe('InMemoryAddressBook', () => {
  let book: InMemoryAddressBook;

  beforeEach(() => {
    book = new InMemoryAddressBook();
  });

  it('starts empty', () => {
    expect(book.size).toBe(0);
    expect(book.entries()).toHaveLength(0);
  });

  it('set and get an alias', () => {
    book.set('alice', ALICE);
    expect(book.get('alice')).toBe(ALICE);
    expect(book.size).toBe(1);
  });

  it('has returns true for registered aliases', () => {
    book.set('alice', ALICE);
    expect(book.has('alice')).toBe(true);
    expect(book.has('bob')).toBe(false);
  });

  it('get returns undefined for unknown aliases', () => {
    expect(book.get('unknown')).toBeUndefined();
  });

  it('overwrites an existing alias on re-set', () => {
    book.set('alice', ALICE);
    book.set('alice', BOB);
    expect(book.get('alice')).toBe(BOB);
    expect(book.size).toBe(1);
  });

  it('stores optional notes', () => {
    book.set('alice', ALICE, 'payroll wallet');
    const entry = book.entries()[0]!;
    expect(entry.notes).toBe('payroll wallet');
  });

  it('delete removes an alias and returns true', () => {
    book.set('alice', ALICE);
    expect(book.delete('alice')).toBe(true);
    expect(book.has('alice')).toBe(false);
    expect(book.size).toBe(0);
  });

  it('delete returns false for unknown alias', () => {
    expect(book.delete('nobody')).toBe(false);
  });

  it('clear removes all entries', () => {
    book.set('alice', ALICE);
    book.set('bob', BOB);
    book.clear();
    expect(book.size).toBe(0);
  });

  it('entries returns all registered entries in insertion order', () => {
    book.set('alice', ALICE);
    book.set('bob', BOB);
    const entries = book.entries();
    expect(entries.map((e) => e.alias)).toEqual(['alice', 'bob']);
  });

  // ── resolve ──────────────────────────────────────────────────────────────

  describe('resolve', () => {
    it('resolves a registered alias to its address', () => {
      book.set('alice', ALICE);
      expect(book.resolve('alice')).toBe(ALICE);
    });

    it('passes through a raw G-address unchanged', () => {
      expect(book.resolve(ALICE)).toBe(ALICE);
    });

    it('throws AddressBookNotFoundError for unknown alias', () => {
      expect(() => book.resolve('nobody')).toThrow(AddressBookNotFoundError);
    });

    it('throws AddressBookNotFoundError for an invalid address that is not an alias', () => {
      expect(() => book.resolve('invalid-address')).toThrow(AddressBookNotFoundError);
    });
  });

  // ── validation ───────────────────────────────────────────────────────────

  describe('validation', () => {
    it('throws AddressBookValidationError for an invalid address', () => {
      expect(() => book.set('bad', 'NOT_A_VALID_ADDRESS')).toThrow(AddressBookValidationError);
    });

    it('throws AddressBookValidationError for an empty address', () => {
      expect(() => book.set('empty', '')).toThrow(AddressBookValidationError);
    });
  });

  // ── import / export ───────────────────────────────────────────────────────

  describe('import', () => {
    it('imports from an array of entries', () => {
      book.import([
        { alias: 'alice', address: ALICE },
        { alias: 'bob', address: BOB },
      ]);
      expect(book.size).toBe(2);
      expect(book.get('alice')).toBe(ALICE);
    });

    it('imports from a plain record', () => {
      book.import({ alice: ALICE, bob: BOB });
      expect(book.size).toBe(2);
      expect(book.get('bob')).toBe(BOB);
    });

    it('merges with existing entries (overwrite on collision)', () => {
      book.set('alice', ALICE);
      book.import({ alice: BOB });
      expect(book.get('alice')).toBe(BOB);
    });
  });

  describe('export', () => {
    it('exports as a plain alias → address record', () => {
      book.set('alice', ALICE);
      book.set('bob', BOB);
      expect(book.export()).toEqual({ alice: ALICE, bob: BOB });
    });

    it('returns an empty object when book is empty', () => {
      expect(book.export()).toEqual({});
    });
  });
});

// ── PersistedAddressBook ──────────────────────────────────────────────────

describe('PersistedAddressBook', () => {
  function makeStorage(): StorageAdapter & { store: Record<string, string> } {
    const store: Record<string, string> = {};
    return {
      store,
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    };
  }

  it('starts empty with fresh storage', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage });
    expect(book.size).toBe(0);
  });

  it('persists entries to storage on set', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage });
    book.set('alice', ALICE);

    // The storage key must contain the entry
    const raw = storage.getItem('sorostream_address_book');
    expect(raw).not.toBeNull();
    const entries = JSON.parse(raw!);
    expect(entries[0].alias).toBe('alice');
    expect(entries[0].address).toBe(ALICE);
  });

  it('loads existing entries from storage on construction', () => {
    const storage = makeStorage();
    // Pre-seed storage
    storage.setItem(
      'sorostream_address_book',
      JSON.stringify([{ alias: 'alice', address: ALICE }]),
    );

    const book = new PersistedAddressBook({ storage });
    expect(book.size).toBe(1);
    expect(book.get('alice')).toBe(ALICE);
  });

  it('two instances backed by the same storage share data after re-construction', () => {
    const storage = makeStorage();
    const book1 = new PersistedAddressBook({ storage });
    book1.set('alice', ALICE);

    // Simulate a page reload / process restart
    const book2 = new PersistedAddressBook({ storage });
    expect(book2.get('alice')).toBe(ALICE);
  });

  it('delete persists the removal', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage });
    book.set('alice', ALICE);
    book.delete('alice');

    const book2 = new PersistedAddressBook({ storage });
    expect(book2.has('alice')).toBe(false);
  });

  it('clear persists the cleared state', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage });
    book.set('alice', ALICE);
    book.set('bob', BOB);
    book.clear();

    const book2 = new PersistedAddressBook({ storage });
    expect(book2.size).toBe(0);
  });

  it('uses a custom storageKey when provided', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage, storageKey: 'custom_key' });
    book.set('carol', CAROL);

    expect(storage.getItem('custom_key')).not.toBeNull();
    expect(storage.getItem('sorostream_address_book')).toBeNull();
  });

  it('survives corrupt storage gracefully (starts empty)', () => {
    const storage = makeStorage();
    storage.setItem('sorostream_address_book', 'NOT_JSON{{{');

    const book = new PersistedAddressBook({ storage });
    expect(book.size).toBe(0);
  });

  it('works without storage (null) — behaves like InMemoryAddressBook', () => {
    // Pass null-ish storage adapter by not providing one; the implementation
    // handles missing localStorage gracefully.
    const book = new PersistedAddressBook({ storage: undefined });
    book.set('alice', ALICE);
    expect(book.get('alice')).toBe(ALICE);
  });

  it('resolve works the same as InMemoryAddressBook', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage });
    book.set('alice', ALICE);

    expect(book.resolve('alice')).toBe(ALICE);
    expect(book.resolve(BOB)).toBe(BOB);
    expect(() => book.resolve('nobody')).toThrow(AddressBookNotFoundError);
  });

  it('import persists all entries', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage });
    book.import({ alice: ALICE, bob: BOB });

    const book2 = new PersistedAddressBook({ storage });
    expect(book2.size).toBe(2);
  });

  it('export returns alias → address map', () => {
    const storage = makeStorage();
    const book = new PersistedAddressBook({ storage });
    book.set('alice', ALICE);
    expect(book.export()).toEqual({ alice: ALICE });
  });
});

// ── Error types ───────────────────────────────────────────────────────────

describe('AddressBookValidationError', () => {
  it('has the correct name', () => {
    const err = new AddressBookValidationError('alias', 'bad');
    expect(err.name).toBe('AddressBookValidationError');
    expect(err.message).toContain('alias');
    expect(err.message).toContain('bad');
  });
});

describe('AddressBookNotFoundError', () => {
  it('has the correct name', () => {
    const err = new AddressBookNotFoundError('nobody');
    expect(err.name).toBe('AddressBookNotFoundError');
    expect(err.message).toContain('nobody');
  });
});
