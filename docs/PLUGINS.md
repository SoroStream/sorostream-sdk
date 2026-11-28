# Plugin / Middleware System

The SDK's plugin system lets you attach hooks that run before, after, or on error of any client method. Use cases include logging, metrics, request validation, retry logic, and analytics.

## Interface

Every plugin implements the `SoroStreamPlugin` interface:

```typescript
interface MiddlewareContext {
  method: string;     // e.g. "createStream"
  args: unknown[];    // arguments passed to the method
}

interface SoroStreamPlugin {
  before?(ctx: MiddlewareContext): void | Promise<void>;
  after?(ctx: MiddlewareContext, result: unknown): void | Promise<void>;
  onError?(ctx: MiddlewareContext, error: unknown): void | Promise<void>;
}
```

| Hook | When it fires | Throw to abort |
|------|---------------|----------------|
| `before` | Before the method executes | Yes — prevents the call |
| `after` | After the method resolves successfully | No — return value already set |
| `onError` | When the method throws | Re-throw to replace the error; return to swallow it |

## Registration

Pass plugins at construction or register them dynamically:

```typescript
// Via constructor
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter,
  plugins: [myPlugin],
});

// Dynamic registration (chainable)
client.use(pluginA).use(pluginB);
```

Plugins execute in registration order for `before` hooks and reverse order for `after` / `onError`.

## Worked Example: Logging Middleware

```typescript
import {
  SoroStreamClient,
  createKeypairAdapter,
  type SoroStreamPlugin,
  type MiddlewareContext,
} from "@sorostream/sdk";

const loggingPlugin: SoroStreamPlugin = {
  before(ctx: MiddlewareContext) {
    console.log(`[SDK] Calling ${ctx.method} with:`, ...ctx.args);
  },
  after(_ctx: MiddlewareContext, result: unknown) {
    console.log(`[SDK] ${_ctx.method} succeeded →`, result);
  },
  onError(ctx: MiddlewareContext, error: unknown) {
    console.error(`[SDK] ${ctx.method} failed:`, error);
  },
};

const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter: createKeypairAdapter("SA..."),
  plugins: [loggingPlugin],
});

// Every call is now logged automatically
await client.createStream({ ... });
```

See [examples/logging-middleware.ts](./examples/logging-middleware.ts) for a runnable version.

## Worked Example: Retry-Override Middleware

A plugin that retries failed `getStream` calls once:

```typescript
import type { SoroStreamPlugin, MiddlewareContext } from "@sorostream/sdk";

const retryPlugin: SoroStreamPlugin = {
  async onError(ctx: MiddlewareContext, error: unknown) {
    if (ctx.method === "getStream") {
      console.log(`[Retry] getStream failed, retrying once...`);
      // Re-throw a different error to signal the caller
      throw new Error(`getStream failed after retry: ${error}`);
    }
    // For other methods, let the original error propagate
  },
};
```

## Hook Execution Order

Given plugins `[A, B]`:

```
before A → before B → [method runs] → after B → after A
```

On error:

```
before A → before B → [method throws] → onError B → onError A → throw
```

## Best Practices

- Keep hooks **fast** — they block the method call.
- Don't mutate `ctx.args` unless you intend to change the call.
- `onError` that does **not** re-throw swallows the error (use with care).
- Register global plugins at construction; register transient plugins via `client.use()`.

## Type Reference

| Export | Source |
|--------|--------|
| `SoroStreamPlugin` | `src/types.ts:636` |
| `MiddlewareContext` | `src/types.ts:628` |
| `client.use()` | `src/SoroStreamClient.ts:379` |
| `plugins` option | `SoroStreamClientOptions.plugins` |
