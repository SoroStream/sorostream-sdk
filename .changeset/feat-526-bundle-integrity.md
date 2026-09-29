---
"@sorostream/sdk": minor
---

feat(#526): subresource integrity manifest for published npm bundle

Adds SHA-256 checksum manifest generation for the built SDK bundle.
The `generate-integrity` script produces `dist/integrity-manifest.json`
after every build. Consumers can use `verifyManifest()` to validate
downloaded bundle files match the expected hashes.
