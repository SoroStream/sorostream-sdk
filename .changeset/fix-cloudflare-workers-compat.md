---
"@sorostream/sdk": patch
---

fix(#406): Cloudflare Workers compatibility — removed Node.js Buffer API usage

The SDK no longer relies on the Node.js `Buffer` class in hot paths:

- `encodeMemoHash` now accepts a plain `Uint8Array` and converts it to a
  64-char lowercase hex string before passing to `Memo.hash()`, which the
  Stellar SDK accepts in all environments.
- `decodeMemo` returns `Uint8Array` instead of `Buffer` for hash/return memos.
- `parseMemo` (utils) uses a static `Memo` import and passes the hex string
  directly to `Memo.hash()` — no `require()` call, no `Buffer.from()`.
- `wallet.ts` passphrase hashing uses `TextEncoder` instead of `Buffer.from`.
- `MemoHash` type is now `Uint8Array` (was `Buffer`).

These changes are compatible with Cloudflare Workers, Deno, Bun, and browsers
in addition to Node.js. Callers currently passing a `Buffer` to
`encodeMemoHash` or `WriteOptions.memo` will continue to work since `Buffer`
is a subclass of `Uint8Array`.
