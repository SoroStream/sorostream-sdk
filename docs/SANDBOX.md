# 🧪 SoroStream SDK Sandbox Mode (`SoroStreamSandbox`)

`SoroStreamSandbox` provides an in-memory, fully offline testing environment for applications integrating `@sorostream/sdk`. It acts as a drop-in replacement for `SoroStreamClient`, executing operations locally without connecting to Stellar RPC endpoints or submitting on-chain transactions.

---

## 🎯 Features

- **Zero RPC Dependency**: Runs entirely in-memory with flow-rate mathematics and state transitions mirroring on-chain contract behavior.
- **Scenario Configuration**: Override method behaviors or simulate edge-case responses/errors per method.
- **Call Tracking & Assertions**: Built-in inspection and assertion helpers (`assertCalled`, `assertCalledWith`, `getCalls`) to verify application calls.
- **Strict Mode / Policy Enforcement**: Configure unexpected call handling (`"error"`, `"allow"`, or `"warn"`).

---

## 🚀 Quickstart

Import `SoroStreamSandbox` from `@sorostream/sdk/testing` (or `@sorostream/sdk`):

```ts
import { SoroStreamSandbox } from "@sorostream/sdk/testing";

const sandbox = new SoroStreamSandbox("GSANDBOX_SENDER_ADDRESS...");
```

---

## 💡 Complete Example Test: Create -> Watch Claimable -> Withdraw Flow

Below is a complete test using Vitest (or Jest) demonstrating a full streaming lifecycle tested strictly through `SoroStreamSandbox`:

```ts
import { describe, it, expect, vi } from "vitest";
import { SoroStreamSandbox } from "@sorostream/sdk/testing";
import { watchClaimable } from "@sorostream/sdk";

describe("Stream Lifecycle with SoroStreamSandbox", () => {
  it("executes createStream -> watchClaimable -> withdraw flow offline", async () => {
    // 1. Instantiate Sandbox (Drop-in replacement for SoroStreamClient)
    const sandbox = new SoroStreamSandbox("GSENDER_1234567890");
    const RECIPIENT = "GRECIPIENT_9876543210";
    const TOKEN = "GUSDC_TOKEN_ADDRESS";

    // 2. Operation 1: Create a payment stream
    const createResult = await sandbox.createStream({
      recipient: RECIPIENT,
      token: TOKEN,
      amount: 1_000_000_000n, // 100 USDC in stroops
      durationSeconds: 3600, // 1 hour
      autoRenew: false,
    });

    expect(createResult.streamId).toBeDefined();
    expect(createResult.txHash).toContain("mock-tx-create");

    // Fetch stream details
    const stream = await sandbox.getStream(createResult.streamId);
    expect(stream.status).toBe("Active");
    expect(stream.recipient).toBe(RECIPIENT);

    // 3. Operation 2: Watch claimable balance
    const onTick = vi.fn();
    const unsubscribe = watchClaimable(
      stream,
      () => sandbox.getClaimable(stream.id),
      onTick,
      { tickMs: 100 }
    );

    // Advance mock time in sandbox by 360 seconds (10% of stream duration)
    sandbox.advanceTime(stream.id, 360);

    const claimable = await sandbox.getClaimable(stream.id);
    expect(claimable).toBeGreaterThan(0n);

    // 4. Operation 3: Withdraw accrued claimable funds
    const withdrawResult = await sandbox.withdraw({ streamId: stream.id });
    expect(withdrawResult.txHash).toBeDefined();
    expect(BigInt(withdrawResult.amount)).toBeGreaterThan(0n);

    unsubscribe();

    // 5. Assertions: Verify expected calls were recorded
    sandbox.assertCalled("createStream", 1);
    sandbox.assertCalled("withdraw", 1);
    sandbox.assertCalledWith("createStream", ([params]) => {
      return (params as any).recipient === RECIPIENT;
    });
  });
});
```

---

## ⚙️ Scenario Configuration

You can override default operation behavior using `configureScenario`:

```ts
const sandbox = new SoroStreamSandbox();

// Mock a custom error scenario when getStream is called
sandbox.configureScenario("getStream", (streamId: string) => {
  if (streamId === "invalid") {
    throw new Error("Stream not found: invalid");
  }
  return { id: streamId, status: "Active" };
});

// Clear custom scenarios
sandbox.clearScenarios();
```

---

## ⚠️ Common Error Patterns & Handling

### 1. Unexpected Calls in Strict Mode
When `setUnexpectedCallPolicy("error")` is set, any call to an unconfigured non-default method will throw an unexpected call error:

```ts
sandbox.setUnexpectedCallPolicy("error");

// Throws: "Unexpected call to unconfigured sandbox operation: customMethod"
await (sandbox as any).customMethod();
```

### 2. Invalid Parameters
Like the real on-chain client, `SoroStreamSandbox` validates core parameters:
- `amount <= 0n` -> throws `Error("Amount must be > 0")`
- `durationSeconds <= 0` -> throws `Error("Duration must be > 0")`
- `getStream("non-existent-id")` -> throws `Error("Stream not found: ...")`

```ts
await expect(
  sandbox.createStream({
    recipient: "GRECIPIENT",
    token: "GUSDC",
    amount: 0n, // Invalid
    durationSeconds: 3600,
    autoRenew: false,
  })
).rejects.toThrow("Amount must be > 0");
```

---

## 🔄 Using Sandbox as a Drop-in Replacement

Since `SoroStreamSandbox` inherits from `MockSoroStreamClient` and conforms to `SoroStreamClient`'s public interface, you can pass it directly into application services or components expecting `SoroStreamClient`:

```ts
function processPayout(client: Pick<SoroStreamClient, "createStream">, recipient: string) {
  return client.createStream({
    recipient,
    token: "GUSDC",
    amount: 500_000_000n,
    durationSeconds: 86400,
    autoRenew: false,
  });
}

// In unit tests:
const sandbox = new SoroStreamSandbox();
await processPayout(sandbox as any, "GRECIPIENT...");
sandbox.assertCalled("createStream");
```
