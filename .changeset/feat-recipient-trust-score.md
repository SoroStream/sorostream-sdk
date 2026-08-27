---
"@sorostream/sdk": minor
---

feat(#405): optional recipient trust score / KYC integration hook

A new `onRecipientTrustScore` option is available on `SoroStreamClientOptions`.
When provided, the hook is called with the resolved recipient address before
every `createStream` transaction is submitted. Throwing any error from the
hook blocks stream creation and propagates the error to the caller.

```ts
const client = new SoroStreamClient({
  // ...
  onRecipientTrustScore: async (recipient) => {
    const result = await myKycProvider.score(recipient);
    if (result.blocked) throw new Error(`Recipient ${recipient} is blocked`);
    return { score: result.score, label: result.tier };
  },
});
```

Two new types are exported: `RecipientTrustScore` and `RecipientTrustScoreProvider`.
