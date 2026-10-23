---
'@sorostream/sdk': patch
---

feat(profiler): re-export `GasProfiler` and its types (`SimulationProfile`, `ProfileReport`, `ProfilerConfig`) from the main entry point so consumers can preview fee costs before submitting transactions (issue #758)
feat(rate-limiter): re-export `RateLimiter` from the main entry point; it serves a distinct purpose as a general-purpose async concurrency limiter, complementary to `WriteRateLimiter` (token-bucket) and `PriorityRequestQueue` (priority lanes) (issue #759)
feat(replayTransport): re-export `ReplayTransport`, `ReplayFixtureError`, `ReplayFixtureParseError`, and associated types from the main entry point for deterministic fixture-based testing (issue #760)
test(federationPlugin): add test coverage for cache invalidation when a second federation lookup for the same address returns a different `account_id`, verifying the cache entry is updated rather than bypassed (issue #737)
