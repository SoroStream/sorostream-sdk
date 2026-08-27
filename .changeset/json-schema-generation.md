---
"@sorostream/sdk": minor
---

Add JSON Schema generation for SDK config and stream parameter types (issue #267). Non-TypeScript tooling can now validate `SoroStreamClientConfig`, `CreateStreamParams`, and `StreamFilter` payloads against machine-readable JSON Schema files published at `@sorostream/sdk/schemas/*` (usable directly with `ajv` or any Draft-07 validator). Schemas are generated from the TypeScript source via `npm run generate-schemas` / the `sorostream-generate-schemas` CLI, and a `check:schemas` script (wired into CI) fails the build if the committed schemas drift out of sync with the types.
