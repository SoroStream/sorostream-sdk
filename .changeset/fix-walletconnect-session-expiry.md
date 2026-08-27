---
"@sorostream/sdk": patch
---

fix(#453): WalletConnect adapter detects expired sessions and prompts the user to reconnect

`createWalletConnectV2Adapter` now tracks the WalletConnect session's expiry and
monitors the `session_delete` / `session_expire` events. When a session expires
(or is deleted) between signing operations:

- `isConnected()` reports `false` instead of returning `true` for the stale session.
- The next `signTransaction` / `getPublicKey` call re-runs `signClient.connect()`,
  surfacing the wallet's reconnect prompt, instead of silently failing.
- A stale-topic signing error from the relay is normalised into the new
  `WalletConnectSessionExpiredError` so callers can catch it explicitly.
- `onConnectionChange` subscribers are notified when the session is lost and
  when a new session is established.
