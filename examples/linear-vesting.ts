/**
 * examples/linear-vesting.ts
 *
 * Linear-only vesting: tokens stream at a constant rate from startTime to endTime.
 * No cliff — tokens are claimable from the first second.
 *
 * Run:
 *   npx tsx examples/linear-vesting.ts
 */

import {
  SoroStreamClient,
  createKeypairAdapter,
  toStroops,
  formatUSDC,
  calculateVestingSchedule,
} from "@sorostream/sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const SECRET_KEY = process.env.STELLAR_SECRET_KEY ?? "SA_YOUR_FUNDED_TESTNET_KEY";
const CONTRACT_ID = process.env.CONTRACT_ID ?? "YOUR_CONTRACT_ID";
const RECIPIENT = process.env.RECIPIENT ?? "GRECIPIENT_ADDRESS_HERE";
const USDC_TOKEN = process.env.USDC_TOKEN ?? "GUSDC_TOKEN_ADDRESS_HERE";

// 1 000 USDC streamed over 365 days
const AMOUNT = toStroops("1000");
const DURATION_SECONDS = 365 * 24 * 60 * 60;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const adapter = createKeypairAdapter(SECRET_KEY);
  const client = new SoroStreamClient({
    network: "testnet",
    contractId: CONTRACT_ID,
    walletAdapter: adapter,
  });

  console.log("Creating linear vesting stream…");
  const { streamId, txHash } = await client.createStream({
    recipient: RECIPIENT,
    token: USDC_TOKEN,
    amount: AMOUNT,
    durationSeconds: DURATION_SECONDS,
    autoRenew: false,
  });
  console.log(`  streamId : ${streamId}`);
  console.log(`  txHash   : ${txHash}`);

  // Fetch the stream and display the vesting schedule milestones.
  const stream = await client.getStream(streamId);
  const schedule = calculateVestingSchedule(stream, 0 /* no cliff */);

  console.log("\nVesting milestones (linear):");
  for (const m of schedule.milestones) {
    const date = new Date(m.time * 1000).toISOString().slice(0, 10);
    console.log(`  ${date}  →  ${formatUSDC(m.vested)} USDC vested`);
  }

  // Simulate time: check claimable after 30 days
  const thirtyDays = 30 * 24 * 60 * 60;
  const simulatedNow = stream.startTime + thirtyDays;
  const simulatedSchedule = calculateVestingSchedule(stream, 0, simulatedNow);
  console.log(
    `\nClaimable after 30 days: ${formatUSDC(simulatedSchedule.effectiveClaimable)} USDC`
  );
}

main().catch(console.error);
