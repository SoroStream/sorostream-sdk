---
@sorostream/eslint-plugin: minor
---

Add no-magic-flow-rate rule to @sorostream/eslint-plugin (issue #574)

The new rule warns when numeric literals are used for flowRate values instead of using the SDK's toStroops() or ratePerSecond() utilities. This helps prevent hardcoded numeric flow rates which are unreadable and error-prone.

The rule suggests using toStroops(amount) or ratePerSecond(amount, period) instead of raw numeric literals.