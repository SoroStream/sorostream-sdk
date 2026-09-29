---
"@sorostream/sdk": minor
---

feat(#513): add rateCalculator utility for streaming rate conversions

Adds `rateCalculator`, `toRatePerSecond`, `fromRatePerSecond`, and `toRatePerMonth`
utilities to convert payment amounts between per-second, per-minute, per-hour,
per-day, per-week, and per-month rates. Handles edge cases where results round to zero.
