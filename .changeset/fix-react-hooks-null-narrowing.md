---
"@sorostream/react": patch
---

Fix a TypeScript strict-null error in `useStream`/`useClaimable`: the nested async fetch callback now captures `client`/`streamId` in a narrowed local binding instead of referencing the outer nullable parameters directly.
