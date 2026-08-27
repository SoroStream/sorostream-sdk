# Contributing to sorostream-sdk

Thank you for your interest in contributing to SoroStream! This repo participates in the **Stellar Wave Program** on [Drips Wave](https://drips.network/wave).

## Wave Contributor Workflow

1. **Browse open issues** â€” find one labelled `Stellar Wave` with a complexity you're comfortable with.
2. **Apply via Drips Wave** â€” do **not** begin coding until the maintainer assigns you to the issue.
3. **Fork the repo** and create a branch:
   - Bug fixes: `fix/N-short-description`
   - Features: `feat/N-short-description`
   - Where `N` is the issue number (e.g. `feat/4-event-listener`).
4. **Write code and tests** â€” `npm test` and `npm run lint` must pass.
5. **Open a PR** â€” title must reference the issue, body must include `Closes #N`.
6. **Await review** â€” maintainer reviews and merges. Points awarded once resolved before Wave ends.

## Local Setup

```bash
npm install
npm test       # run vitest unit tests
npm run lint   # TypeScript type check
npm run build  # build with tsup
```

## Code Style

- Strict TypeScript â€” no `any` types.
- All public methods must have JSDoc comments.
- Use `bigint` for all stroop amounts.

## Changelog Format

Keep changelog entries consistent with the Keep a Changelog style. When updating the changelog, use the following structure:

- Add a section header with one of these categories: Added, Changed, Fixed, Removed, Deprecated.
- Use one bullet per entry in the format `- Short description (#issue)`.
- Keep entries short and imperative.

Example:

```md
## [Unreleased]

### Added
- Add zero cliff duration regression test (#152)
```

Before opening a PR, run `node scripts/check-changelog-format.js --staged` if you touched `CHANGELOG.md`.

## Bundle Size Enforcement

This project enforces bundle size limits to maintain performance for end users. Bundle sizes are checked in CI on every PR.

### Size Limits (gzipped)

- `@sorostream/sdk` (full) ≤ 120 KB
- `@sorostream/sdk/wallets` ≤ 50 KB
- `@sorostream/sdk/mock` ≤ 80 KB
- `@sorostream/sdk/testing` ≤ 30 KB

### Local Bundle Size Check

Before submitting a PR, verify bundle sizes locally:

```bash
npm run build      # Build the SDK
npm run size:check # Check sizes with detailed breakdown
```

The `npm run size` command will exit with non-zero status if any entry point exceeds its limit, preventing accidental regressions from being merged.

### Addressing Bundle Size Increases

If your changes increase bundle size:

1. **Review your changes** – check if new dependencies were added or code grew unexpectedly.
2. **Optimize** – consider:
   - Lazy-loading dependencies
   - Tree-shaking opportunities
   - Removing unused code paths
3. **Update limits** – if the increase is justified, update `.size-limit.json` and explain the change in your PR description.
