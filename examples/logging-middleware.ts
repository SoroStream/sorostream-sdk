/**
 * examples/logging-middleware.ts
 *
 * Demonstrates the plugin/middleware system with a simple logger that
 * prints every SDK call, its result, and any errors.
 *
 * Run:
 *   npx tsx examples/logging-middleware.ts
 */

import {
  SoroStreamClient,
  createKeypairAdapter,
  toStroops,
  type SoroStreamPlugin,
  type MiddlewareContext,
} from "@sorostream/sdk";

// ── Plugin ───────────────────────────────────────────────────────────────────

const loggingPlugin: SoroStreamPlugin = {
  before(ctx: MiddlewareContext) {
    console.log(`[Plugin:before] ${ctx.method} called with:`, ...ctx.args);
  },
  after(ctx: MiddlewareContext, result: unknown) {
    console.log(`[Plugin:after]  ${ctx.method} succeeded →`, result);
  },
  onError(ctx: MiddlewareContext, error: unknown) {
    console.error(`[Plugin:error] ${ctx.method} failed:`, error);
  },
};

// ── Config ────────────────────────────────────────────────────────────────────

const SECRET_KEY = process.env.STELLAR_SECRET_KEY ?? "SA_YOUR_FUNDED_TESTNET_KEY";
const CONTRACT_ID = process.env.CONTRACT_ID ?? "YOUR_CONTRACT_ID";
const RECIPIENT = process.env.RECIPIENT ?? "GRECIPIENT_ADDRESS_HERE";
const USDC_TOKEN = process.env.USDC_TOKEN ?? "GUSDC_TOKEN_ADDRESS_HERE";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const adapter = createKeypairAdapter(SECRET_KEY);
  const client = new SoroStreamClient({
    network: "testnet",
    contractId: CONTRACT_ID,
    walletAdapter: adapter,
    plugins: [loggingPlugin],
  });

  // Each SDK call will log before/after via the plugin
  console.log("\n--- Creating stream ---\n");
  const { streamId } = await client.createStream({
    recipient: RECIPIENT,
    token: USDC_TOKEN,
    amount: toStroops("10"),
    durationSeconds: 7 * 24 * 60 * 60, // 7 days
    autoRenew: false,
  });

  console.log("\n--- Fetching stream ---\n");
  const stream = await client.getStream(streamId);
  console.log("Stream:", stream.id, "status:", stream.status);

  console.log("\n--- Checking claimable ---\n");
  const claimable = await client.getClaimable(streamId);
  console.log("Claimable:", claimable.toString(), "stroops");

  console.log("\nDone — plugin logged every call above.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
