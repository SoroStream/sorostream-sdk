#!/usr/bin/env node
import { Command } from 'commander';
import type { GlobalOptions } from './commands.js';
import {
  cmdCreate,
  cmdGet,
  cmdWithdraw,
  cmdCancel,
  cmdTopUp,
  cmdClaimable,
  cmdForecast,
} from './commands.js';
import { cmdAnalyze } from './analyze.js';

const program = new Command();

program
  .name('sorostream')
  .description('CLI tool for the SoroStream payment streaming protocol on Stellar Soroban')
  .version('0.1.0')
  .requiredOption('-c, --contract-id <address>', 'StreamContract address')
  .option('-n, --network <network>', 'Stellar network (mainnet/testnet/futurenet)', 'testnet')
  .option('-r, --rpc <urls...>', 'RPC URL(s) — specify multiple for failover')
  .requiredOption(
    '-s, --secret <key>',
    'Stellar secret key (or set SOROSTREAM_SECRET env var)',
    process.env.SOROSTREAM_SECRET,
  );

// --- create ----------------------------------------------------------------
program
  .command('create')
  .description('Create a new payment stream')
  .requiredOption('--recipient <address>', 'Recipient Stellar address')
  .requiredOption('--token <address>', 'Token contract address (e.g. USDC)')
  .requiredOption('--amount <usdc>', 'Amount in USDC (e.g. 100.50)')
  .requiredOption('--duration <seconds>', 'Duration in seconds', parseInt)
  .option('--auto-renew', 'Enable auto-renewal', false)
  .action(async (opts) => {
    const global = program.opts<GlobalOptions>();
    await cmdCreate({ ...global, ...opts });
  });

// --- get -------------------------------------------------------------------
program
  .command('get')
  .description('Get stream details')
  .argument('<streamId>', 'Stream ID')
  .action(async (streamId) => {
    const opts = program.opts<GlobalOptions>();
    await cmdGet(opts, streamId);
  });

// --- withdraw --------------------------------------------------------------
program
  .command('withdraw')
  .description('Withdraw all claimable tokens from a stream')
  .argument('<streamId>', 'Stream ID')
  .action(async (streamId) => {
    const opts = program.opts<GlobalOptions>();
    await cmdWithdraw(opts, streamId);
  });

// --- cancel ----------------------------------------------------------------
program
  .command('cancel')
  .description('Cancel an active stream')
  .argument('<streamId>', 'Stream ID')
  .action(async (streamId) => {
    const opts = program.opts<GlobalOptions>();
    await cmdCancel(opts, streamId);
  });

// --- top-up ----------------------------------------------------------------
program
  .command('top-up')
  .description('Top up a stream with additional tokens')
  .argument('<streamId>', 'Stream ID')
  .requiredOption('--amount <usdc>', 'Amount in USDC to add')
  .action(async (streamId, opts) => {
    const global = program.opts<GlobalOptions>();
    await cmdTopUp({ ...global, ...opts }, streamId);
  });

// --- claimable -------------------------------------------------------------
program
  .command('claimable')
  .description('Get the claimable amount for a stream')
  .argument('<streamId>', 'Stream ID')
  .action(async (streamId) => {
    const opts = program.opts<GlobalOptions>();
    await cmdClaimable(opts, streamId);
  });

// --- forecast --------------------------------------------------------------
program
  .command('forecast')
  .description('Get the renewal forecast for an auto-renewing stream')
  .argument('<streamId>', 'Stream ID')
  .action(async (streamId) => {
    const opts = program.opts<GlobalOptions>();
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

program.parse();
