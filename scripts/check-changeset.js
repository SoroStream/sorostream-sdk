#!/usr/bin/env node
const { execSync } = require('child_process');

try {
  // Get base branch from args, default to origin/main
  const args = process.argv.slice(2);
  let baseBranch = 'origin/main';
  const baseIndex = args.indexOf('--base');
  if (baseIndex !== -1 && args[baseIndex + 1]) {
    baseBranch = args[baseIndex + 1];
  } else {
    const baseArg = args.find((a) => a.startsWith('--base='));
    if (baseArg) {
      baseBranch = baseArg.split('=')[1];
    }
  }

  // Get changed files
  let diffOutput = '';
  try {
    diffOutput = execSync(`git diff --name-only ${baseBranch}...HEAD`).toString().trim();
  } catch (err) {
    // If exact diff fails, fallback to standard diff
    diffOutput = execSync(`git diff --name-only ${baseBranch} HEAD`).toString().trim();
  }

  const changedFiles = diffOutput.split('\n').filter(Boolean);

  if (changedFiles.length === 0) {
    console.log('No files changed.');
    process.exit(0);
  }

  // Define what paths require a changeset
  const requiresChangeset = changedFiles.some(
    (f) => f.startsWith('src/') || f.startsWith('packages/'),
  );

  if (requiresChangeset) {
    const changesetAdded = changedFiles.some(
      (f) => f.startsWith('.changeset/') && f.endsWith('.md') && !f.includes('README.md'),
    );

    if (!changesetAdded) {
      console.error('❌ Error: Changes to public API detected without a corresponding changeset.');
      console.error('Please run "npx changeset add" to create a changeset file and commit it.');
      process.exit(1);
    } else {
      console.log('✅ Changeset check passed: Changesets found for public API modifications.');
    }
  } else {
    console.log('✅ Changeset check passed: No public API modifications detected.');
  }
} catch (e) {
  console.error('Error running changeset check:', e.message);
  process.exit(1);
}
