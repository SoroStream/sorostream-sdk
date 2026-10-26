#!/usr/bin/env node
import { Command, Option } from 'commander';
import { fileURLToPath } from 'node:url';
import type { GlobalOptions } from './commands.js';
import {
  cmdGet,
  cmdList,
  cmdWithdraw,
  cmdCancel,
  cmdTopUp,
  cmdClaimable,
  cmdForecast,
  cmdStreamCreate,
} from './commands.js';
import { cmdAnalyze } from './analyze.js';
import { OUTPUT_FORMATS } from './output.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('sorostream')
    .description('CLI tool for the SoroStream payment streaming protocol on Stellar Soroban')
    .version('0.1.0')
    .requiredOption('-c, --contract-id <address>', 'StreamContract address')
    .option('-n, --network <network>', 'Stellar network (mainnet/testnet/futurenet)', 'testnet')
    .option('-r, --rpc <urls...>', 'RPC URL(s) — specify multiple for failover')
    .addOption(
      new Option('-o, --output <format>', 'Output format for results')
        .choices([...OUTPUT_FORMATS])
        .default('json'),
    )
    .addOption(
      new Option(
        '-s, --secret <key>',
        '[DEPRECATED] Stellar secret key — set SOROSTREAM_SECRET env var or use interactive prompt instead',
      ),
    );

  function extractGlobalOptions(cmd: Command): GlobalOptions {
    const raw = cmd.opts<GlobalOptions>();
    const secretFromCliFlag = cmd.getOptionValueSource('secret') === 'cli';
    return {
      ...raw,
      secretFromCliFlag,
    };
  }

  // --- stream create ---------------------------------------------------------
  program
    .command('stream create')
    .description('Create a new payment stream')
    .option('--recipient <address>', 'Recipient Stellar address')
    .option('--token <address>', 'Token contract address (e.g. USDC)')
    .option('--amount <usdc>', 'Amount in USDC (e.g. 100.50)')
    .option('--duration <seconds>', 'Duration in seconds', parseInt)
    .option('--auto-renew', 'Enable auto-renewal', false)
    .option('--json', 'Read all params from flags non-interactively (for CI use)', false)
    .action(async (opts) => {
      const global = extractGlobalOptions(program);
      await cmdStreamCreate({ ...global, ...opts });
    });

  // --- list ------------------------------------------------------------------
  program
    .command('list')
    .description('List payment streams filtered by sender, recipient, or status')
    .option('--sender <address>', 'Filter by sender address')
    .option('--recipient <address>', 'Filter by recipient address')
    .option('--status <status>', 'Filter by status (active, cancelled, completed)')
    .option('--limit <number>', 'Maximum number of streams to return', parseInt)
    .option('--cursor <string>', 'Cursor for pagination')
    .action(async (opts) => {
      const global = extractGlobalOptions(program);
      await cmdList({ ...global, ...opts });
    });

  // --- get -------------------------------------------------------------------
  program
    .command('get')
    .description('Get stream details')
    .argument('<streamId>', 'Stream ID')
    .action(async (streamId) => {
      const opts = extractGlobalOptions(program);
      await cmdGet(opts, streamId);
    });

  // --- withdraw --------------------------------------------------------------
  program
    .command('withdraw')
    .description('Withdraw all claimable tokens from a stream')
    .argument('<streamId>', 'Stream ID')
    .action(async (streamId) => {
      const opts = extractGlobalOptions(program);
      await cmdWithdraw(opts, streamId);
    });

  // --- cancel ----------------------------------------------------------------
  program
    .command('cancel')
    .description('Cancel an active stream')
    .argument('<streamId>', 'Stream ID')
    .action(async (streamId) => {
      const opts = extractGlobalOptions(program);
      await cmdCancel(opts, streamId);
    });

  // --- top-up ----------------------------------------------------------------
  program
    .command('top-up')
    .description('Top up a stream with additional tokens')
    .argument('<streamId>', 'Stream ID')
    .requiredOption('--amount <usdc>', 'Amount in USDC to add')
    .action(async (streamId, opts) => {
      const global = extractGlobalOptions(program);
      await cmdTopUp({ ...global, ...opts }, streamId);
    });

  // --- claimable -------------------------------------------------------------
  program
    .command('claimable')
    .description('Get the claimable amount for a stream')
    .argument('<streamId>', 'Stream ID')
    .action(async (streamId) => {
      const opts = extractGlobalOptions(program);
      await cmdClaimable(opts, streamId);
    });

  // --- forecast --------------------------------------------------------------
  program
    .command('forecast')
    .description('Get the renewal forecast for an auto-renewing stream')
    .argument('<streamId>', 'Stream ID')
    .action(async (streamId) => {
      const opts = extractGlobalOptions(program);
      await cmdForecast(opts, streamId);
    });

  // --- analyze ---------------------------------------------------------------
  program
    .command('analyze')
    .description('Analyze bundle size and tree-shaking coverage for an entrypoint')
    .argument('<entrypoint>', 'Path to the entrypoint file to analyze')
    .option('--html', 'Generate an interactive treemap HTML file', false)
    .option('--output-dir <dir>', 'Directory for output files (default: entrypoint directory)')
    .action(async (entrypoint, opts) => {
      await cmdAnalyze({
        entrypoint,
        html: opts.html as boolean,
        outputDir: opts.outputDir as string | undefined,
      });
    });

  return program;
}

const isMain =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  createProgram().parse();
}
