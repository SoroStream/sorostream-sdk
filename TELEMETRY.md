# Telemetry Policy — @sorostream/sdk

## Current status

**As of this version, the SoroStream SDK collects no telemetry whatsoever.**

No usage data, error reports, transaction metadata, wallet addresses, or any
other information is sent to SoroStream servers or any third-party service by
the SDK itself.

---

## What the SDK does _not_ collect

- Wallet addresses or public keys
- Transaction hashes, stream IDs, or contract interactions
- Method call frequency or timing metrics
- IP addresses, device fingerprints, or environment information
- Any personally identifiable information (PII)

---

## Opt-out mechanism

To future-proof privacy-sensitive deployments, the SDK exposes a first-class
opt-out flag today — even though no telemetry is currently collected:

```ts
import { SoroStreamClient } from "@sorostream/sdk";

const client = new SoroStreamClient({
  network: "mainnet",
  contractId: "YOUR_CONTRACT_ID",
  walletAdapter,
  telemetry: false, // ← explicitly opt out of any future telemetry
});
```

Setting `telemetry: false` is a no-op today. When any form of optional
instrumentation is added in a future release it will be:

1. **Disabled by default** — consumers must actively opt in.
2. **Fully documented** in this file _before_ the release ships.
3. **Auditable** — the data collected, the destination endpoint, and the
   transmission mechanism will be listed here.

---

## OpenTelemetry integration

The SDK ships an _optional_ OpenTelemetry tracing layer (`src/telemetry.ts`).
This integration is **entirely passive**: it only activates when the consuming
application has already configured an OpenTelemetry provider (e.g. installed
`@opentelemetry/api` and called `NodeTracerProvider.register()`). The SDK
never installs its own exporter and never sends data anywhere on its own.

To completely disable OTel spans even when a provider is registered, pass
`telemetry: false`:

```ts
const client = new SoroStreamClient({
  // ...
  telemetry: false, // OTel spans will not be emitted
});
```

---

## Verifying telemetry is disabled

The `telemetry` option is stored on the client instance and can be read back:

```ts
console.log(client.isTelemetryEnabled); // false when opt-out was set
```

You can also audit the SDK source at `src/telemetry.ts` and
`src/SoroStreamClient.ts` to confirm no outbound requests originate from
within the SDK.

---

## Governance and future changes

Any future change to this policy (addition of anonymous metrics, error
reporting, etc.) will:

- Require a **minor version bump** (semver).
- Be announced in `CHANGELOG.md` under a dedicated `Telemetry` section.
- Update this document to reflect the new policy **in the same commit** as
  the code change.
- Remain opt-in only — existing `telemetry: false` flags will always suppress
  collection.

---

## Contact

Questions or concerns about privacy? Open an issue at
[github.com/SoroStream/sorostream-sdk](https://github.com/SoroStream/sorostream-sdk/issues)
or email **privacy@sorostream.io**.
