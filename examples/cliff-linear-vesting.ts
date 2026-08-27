/**
 * examples/cliff-linear-vesting.ts
 *
 * Cliff + linear vesting: tokens do not become claimable until the cliff expires,
 * then stream linearly for the remainder of the duration.
 *
 * This uses calculateVestingSchedule (display-only helper) to show milestones.
 * The cliff is enforced client-side — the underlying stream is still linear.
 *
 * Run:
 *   npx tsx examples/cliff-linear-vesting.ts
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

// 4 800 USDC over 4 years, with a 1-year cliff
const AMOUNT = toStroops("4800");
const DURATION_SECONDS = 4 * 365 * 24 * 60 * 60;
const CLIFF_SECONDS = 1 * 365 * 24 * 60 * 60;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const adapter = createKeypairAdapter(SECRET_KEY);
  const client = new SoroStreamClient({
    network: "testnet",
    contractId: CONTRACT_ID,
    walletAdapter: adapter,
  });

  console.log("Creating cliff + linear vesting stream…");
  const { streamId, txHash } = await client.createStream({
    recipient: RECIPIENT,
    token: USDC_TOKEN,
    amount: AMOUNT,
    durationSeconds: DURATION_SECONDS,
    autoRenew: false,
    cliffSeconds: CLIFF_SECONDS,
  });
  console.log(`  streamId : ${streamId}`);
  console.log(`  txHash   : ${txHash}`);

  const stream = await client.getStream(streamId);
  const schedule = calculateVestingSchedule(stream, CLIFF_SECONDS);

  const cliffDate = new Date(schedule.cliffEndTime * 1000).toISOString().slice(0, 10);
  console.log(`\nCliff ends: ${cliffDate}`);
  console.log(`In cliff:   ${schedule.inCliff}`);

  console.log("\nVesting milestones (cliff + linear):");
  for (const m of schedule.milestones) {
    const date = new Date(m.time * 1000).toISOString().slice(0, 10);
    console.log(`  ${date}  →  ${formatUSDC(m.vested)} USDC vested`);
  }

  // Simulate: claimable just before and just after cliff
  const beforeCliff = stream.startTime + CLIFF_SECONDS - 1;
  const afterCliff = stream.startTime + CLIFF_SECONDS + 1;

  const before = calculateVestingSchedule(stream, CLIFF_SECONDS, beforeCliff);
  const after = calculateVestingSchedule(stream, CLIFF_SECONDS, afterCliff);

  console.log(`\nJust before cliff:  ${formatUSDC(before.effectiveClaimable)} USDC claimable`);
  console.log(`Just after cliff:   ${formatUSDC(after.effectiveClaimable)} USDC claimable`);
}

main().catch(console.error);
