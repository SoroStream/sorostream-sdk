/**
 * Address book API (Issue #394).
 *
 * Maps human-readable aliases to Stellar public keys so callers can refer
 * to recipients by name instead of raw G-addresses.
 *
 * Two implementations are provided:
 *
 * - `InMemoryAddressBook`  – backed by a plain `Map`; entries are lost when
 *   the process ends. Suitable for tests and short-lived scripts.
 *
 * - `PersistedAddressBook` – backed by any `StorageAdapter` (defaults to
 *   `localStorage` in browsers, or a custom adapter in Node/React Native).
 *   Entries survive page reloads and process restarts.
 *
 * Both classes implement the `AddressBook` interface, so they are
 * interchangeable.
 *
 * @example In-memory usage:
 * ```ts
 * const book = new InMemoryAddressBook();
 * book.set("alice", "GABC...1");
 * book.set("bob",   "GXYZ...2");
 *
 * const recipient = book.resolve("alice"); // → "GABC...1"
 * await client.createStream({ recipient, ... });
 * ```
 *
 * @example Persisted usage (browser):
 * ```ts
 * const book = new PersistedAddressBook(); // uses localStorage by default
 * book.set("payroll-account", "GDEF...3");
 * // … survives page reload …
 * const addr = book.resolve("payroll-account");
 * ```
 *
 * @example Persisted usage (Node / React Native with custom adapter):
 * ```ts
 * const book = new PersistedAddressBook({ storage: myStorageAdapter });
 * ```
 */

import { isValidStellarAddress } from './utils.js';
import type { StorageAdapter } from './adapters.js';

/** An address book entry. */
export interface AddressBookEntry {
  /** Human-readable alias, e.g. `"alice"` or `"payroll-account"`. */
  alias: string;
  /** Stellar public key (G-address). */
  address: string;
  /** Optional free-form notes. */
  notes?: string;
}

/**
 * Common interface implemented by both `InMemoryAddressBook` and
 * `PersistedAddressBook`.
 */
export interface AddressBook {
  /**
   * Registers an alias → address mapping.
   * Overwrites any existing entry for `alias`.
   *
   * @throws {AddressBookValidationError} if `address` is not a valid Stellar G-address.
   */
  set(alias: string, address: string, notes?: string): void;

  /**
   * Removes an alias. Returns `true` if the alias existed, `false` otherwise.
   */
  delete(alias: string): boolean;

  /**
   * Returns the address for `alias`, or `undefined` if the alias is not in
   * the book.
   */
  get(alias: string): string | undefined;

  /**
   * Resolves an alias to its address.  If `aliasOrAddress` is already a
   * valid raw G-address it is returned unchanged, so callers can pass either
   * form without pre-checking.
   *
   * @throws {AddressBookNotFoundError} when `aliasOrAddress` is neither a
   *   known alias nor a valid G-address.
   */
  resolve(aliasOrAddress: string): string;

  /**
   * Returns all entries in insertion order.
   */
  entries(): AddressBookEntry[];

  /**
   * Returns `true` when `alias` has a registered mapping.
   */
  has(alias: string): boolean;

  /**
   * Returns the number of registered aliases.
   */
  readonly size: number;

  /**
   * Removes all entries.
   */
  clear(): void;

  /**
   * Imports entries from a plain object or array, merging with existing
   * entries (overwriting on alias collision).
   */
  import(data: AddressBookEntry[] | Record<string, string>): void;

  /**
   * Exports a snapshot as a plain object `{ alias → address }`.
   */
  export(): Record<string, string>;
}

/** Thrown when an invalid Stellar address is passed to `set`. */
export class AddressBookValidationError extends Error {
  constructor(alias: string, address: string) {
    super(
      `AddressBook: "${address}" is not a valid Stellar address (alias: "${alias}"). ` +
        `Addresses must start with G and be 56 characters long.`,
    );
    this.name = 'AddressBookValidationError';
  }
}

/** Thrown when `resolve` cannot find the alias and the value is not a raw address. */
export class AddressBookNotFoundError extends Error {
  constructor(aliasOrAddress: string) {
    super(
      `AddressBook: "${aliasOrAddress}" is not a registered alias or a valid Stellar address.`,
    );
    this.name = 'AddressBookNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function validateAddress(alias: string, address: string): void {
  if (!isValidStellarAddress(address)) {
    throw new AddressBookValidationError(alias, address);
  }
}

function normaliseImport(
  data: AddressBookEntry[] | Record<string, string>,
): AddressBookEntry[] {
  if (Array.isArray(data)) return data;
  return Object.entries(data).map(([alias, address]) => ({ alias, address }));
}

// ---------------------------------------------------------------------------
// InMemoryAddressBook
// ---------------------------------------------------------------------------

/**
 * A lightweight, in-memory address book backed by a `Map`.
 * Entries do not survive process restarts.
 */
export class InMemoryAddressBook implements AddressBook {
  private readonly _map = new Map<string, AddressBookEntry>();

  set(alias: string, address: string, notes?: string): void {
    validateAddress(alias, address);
    this._map.set(alias, { alias, address, notes });
  }

  delete(alias: string): boolean {
    return this._map.delete(alias);
  }

  get(alias: string): string | undefined {
    return this._map.get(alias)?.address;
  }

  resolve(aliasOrAddress: string): string {
    const entry = this._map.get(aliasOrAddress);
    if (entry) return entry.address;
    if (isValidStellarAddress(aliasOrAddress)) return aliasOrAddress;
    throw new AddressBookNotFoundError(aliasOrAddress);
  }

  entries(): AddressBookEntry[] {
    return [...this._map.values()];
  }

  has(alias: string): boolean {
    return this._map.has(alias);
  }

  get size(): number {
    return this._map.size;
  }

  clear(): void {
    this._map.clear();
  }

  import(data: AddressBookEntry[] | Record<string, string>): void {
    for (const { alias, address, notes } of normaliseImport(data)) {
      this.set(alias, address, notes);
    }
  }

  export(): Record<string, string> {
    return Object.fromEntries([...this._map.values()].map((e) => [e.alias, e.address]));
  }
}

// ---------------------------------------------------------------------------
// PersistedAddressBook
// ---------------------------------------------------------------------------

const DEFAULT_STORAGE_KEY = 'sorostream_address_book';

/** Options for `PersistedAddressBook`. */
export interface PersistedAddressBookOptions {
  /**
   * Storage adapter to use. Defaults to `localStorage` (browser) or a
   * no-op in environments where `localStorage` is not available.
   */
  storage?: StorageAdapter;
  /** Storage key used to persist the address book. Defaults to `"sorostream_address_book"`. */
  storageKey?: string;
}

/**
 * An address book that persists entries via a {@link StorageAdapter}.
 *
 * In browsers the default adapter is `localStorage`; on Node or React Native
 * supply a custom adapter via `options.storage`.
 *
 * All mutating operations (`set`, `delete`, `clear`, `import`) are synchronously
 * flushed to storage so the on-disk state is always consistent with the
 * in-memory map.
 */
export class PersistedAddressBook implements AddressBook {
  private readonly _map = new Map<string, AddressBookEntry>();
  private readonly storage: StorageAdapter | null;
  private readonly storageKey: string;

  constructor(options: PersistedAddressBookOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.storage = options.storage ?? getDefaultStorage();
    this._load();
  }

  // ── Persistence helpers ──────────────────────────────────────────────────

  private _load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const entries: AddressBookEntry[] = JSON.parse(raw);
      for (const entry of entries) {
        this._map.set(entry.alias, entry);
      }
    } catch {
      // Corrupt storage — start fresh
    }
  }

  private _flush(): void {
    if (!this.storage) return;
    this.storage.setItem(this.storageKey, JSON.stringify([...this._map.values()]));
  }

  // ── AddressBook implementation ───────────────────────────────────────────

  set(alias: string, address: string, notes?: string): void {
    validateAddress(alias, address);
    this._map.set(alias, { alias, address, notes });
    this._flush();
  }

  delete(alias: string): boolean {
    const existed = this._map.delete(alias);
    if (existed) this._flush();
    return existed;
  }

  get(alias: string): string | undefined {
    return this._map.get(alias)?.address;
  }

  resolve(aliasOrAddress: string): string {
    const entry = this._map.get(aliasOrAddress);
    if (entry) return entry.address;
    if (isValidStellarAddress(aliasOrAddress)) return aliasOrAddress;
    throw new AddressBookNotFoundError(aliasOrAddress);
  }

  entries(): AddressBookEntry[] {
    return [...this._map.values()];
  }

  has(alias: string): boolean {
    return this._map.has(alias);
  }

  get size(): number {
    return this._map.size;
  }

  clear(): void {
    this._map.clear();
    this._flush();
  }

  import(data: AddressBookEntry[] | Record<string, string>): void {
    for (const { alias, address, notes } of normaliseImport(data)) {
      validateAddress(alias, address);
      this._map.set(alias, { alias, address, notes });
    }
    this._flush();
  }

  export(): Record<string, string> {
    return Object.fromEntries([...this._map.values()].map((e) => [e.alias, e.address]));
  }
}

// ---------------------------------------------------------------------------
// Default storage helper (mirrors getDefaultStorageAdapter in adapters.ts)
// ---------------------------------------------------------------------------

function getDefaultStorage(): StorageAdapter | null {
  if (typeof localStorage !== 'undefined') {
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
      removeItem: (k) => localStorage.removeItem(k),
    };
  }
  return null;
}
