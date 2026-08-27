---
"@sorostream/sdk": patch
---

fix(#407): stream watcher now resumes after device sleep/wake

`EventPoller` and `watchClaimable` both register `visibilitychange` and
`pageshow` event listeners. When the browser or OS wakes the page from
sleep, an immediate poll (EventPoller) or reconciliation (watchClaimable)
is triggered, preventing the stale-balance window that previously lasted
until the next scheduled interval tick.

Listeners are removed on `destroy()` / unsubscribe to avoid leaks.
In environments without `document` or `window` (SSR, Cloudflare Workers,
Node.js) the registration is skipped gracefully.
