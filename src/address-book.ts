/**
 * Address book — separate entry point for the `InMemoryAddressBook` and
 * `PersistedAddressBook` helpers (Issue #755).
 *
 * These classes map human-readable aliases to Stellar public keys so callers
 * can refer to recipients by name instead of raw G-addresses. They are a
 * complete, public-facing feature that was previously only accessible from a
 * direct source checkout. Import from this subpath to avoid pulling in the
 * full SDK surface area.
 *
 * @example
 * ```ts
 * import {
 *   InMemoryAddressBook,
 *   PersistedAddressBook,
 * } from '@sorostream/sdk/address-book';
 *
 * const book = new InMemoryAddressBook();
 * book.set('alice', 'GABC...1');
 * const recipient = book.resolve('alice');
 * ```
 */
export {
  InMemoryAddressBook,
  PersistedAddressBook,
  AddressBookValidationError,
  AddressBookNotFoundError,
} from './addressBook.js';
export type { AddressBook, AddressBookEntry, PersistedAddressBookOptions } from './addressBook.js';
