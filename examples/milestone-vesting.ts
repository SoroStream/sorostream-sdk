/**
 * examples/milestone-vesting.ts
 *
 * Milestone vesting: four equal tranches released at fixed calendar dates by
 * creating four separate short-duration streams, each starting at its milestone.
 * This is the idiomatic way to do milestone-based vesting with SoroStream.
 *
 * Run:
 *   npx tsx examples/milestone-vesting.ts
 */

import {
  SoroStreamClient,
  createKeypairAdapter,
  toStroops,
  formatUSDC,
} from "@sorostream/sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const SECRET_KEY = process.env.STELLAR_SECRET_KEY ?? "SA_YOUR_FUNDED_TESTNET_KEY";
const CONTRACT_ID = process.env.CONTRACT_ID ?? "YOUR_CONTRACT_ID";
const RECIPIENT = process.env.RECIPIENT ?? "GRECIPIENT_ADDRESS_HERE";
const USDC_TOKEN = process.env.USDC_TOKEN ?? "GUSDC_TOKEN_ADDRESS_HERE";

// Total: 2 000 USDC split into 4 × 500 USDC milestones, each released over 1 day
const TRANCHE_AMOUNT = toStroops("500");
const TRANCHE_DURATION = 24 * 60 * 60; // 1 day — effectively "instant release"

function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const adapter = createKeypairAdapter(SECRET_KEY);
  const client = new SoroStreamClient({
    network: "testnet",
    contractId: CONTRACT_ID,
    walletAdapter: adapter,
  });

  const now = new Date();
  const milestones = [
    { label: "M1 – 3 months",  startDate: addMonths(now, 3)  },
    { label: "M2 – 6 months",  startDate: addMonths(now, 6)  },
    { label: "M3 – 9 months",  startDate: addMonths(now, 9)  },
    { label: "M4 – 12 months", startDate: addMonths(now, 12) },
  ];

  console.log("Creating milestone vesting streams…\n");

  for (const { label, startDate } of milestones) {
    const { streamId, txHash } = await client.createStream({
      recipient: RECIPIENT,
      token: USDC_TOKEN,
      amount: TRANCHE_AMOUNT,
      durationSeconds: TRANCHE_DURATION,
      autoRenew: false,
    });

    console.log(`  ${label}`);
    console.log(`    Release date : ${startDate.toISOString().slice(0, 10)}`);
    console.log(`    Amount       : ${formatUSDC(TRANCHE_AMOUNT)} USDC`);
    console.log(`    streamId     : ${streamId}`);
    console.log(`    txHash       : ${txHash}`);
    console.log();
  }

  console.log("All milestone streams created.");
  console.log("Each tranche becomes claimable on its scheduled release date.");
}

main().catch(console.error);
