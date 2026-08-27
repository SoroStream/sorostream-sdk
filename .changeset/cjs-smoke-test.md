---
"@sorostream/sdk": patch
---

Add a CI smoke-test step (`npm run test:cjs`) that verifies `require("@sorostream/sdk")` resolves correctly in a plain Node.js CommonJS script, guarding the existing dual ESM/CJS build output against regressions (issue #198).
