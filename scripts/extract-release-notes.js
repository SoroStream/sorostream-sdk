// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parses CHANGELOG.md and returns the markdown release notes for a specific version section or Unreleased.
 * @param {string} changelogPath
 * @param {string} [version='Unreleased']
 * @returns {string}
 */
function extractReleaseNotes(changelogPath, version = 'Unreleased') {
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`CHANGELOG file not found at: ${changelogPath}`);
  }
  const content = fs.readFileSync(changelogPath, 'utf-8');
  const lines = content.split('\n');

  let capturing = false;
  const capturedLines = [];

  const targetHeaderPattern = new RegExp(`^##\\s+\\[?${version.replace('.', '\\.')}\\]?`, 'i');
  const anyHeaderPattern = /^##\s+/;

  for (const line of lines) {
    if (targetHeaderPattern.test(line)) {
      capturing = true;
      continue;
    }
    if (capturing && anyHeaderPattern.test(line)) {
      break;
    }
    if (capturing) {
      capturedLines.push(line);
    }
  }

  const result = capturedLines.join('\n').trim();
  return result || `No release notes found for version ${version}.`;
}

if (require.main === module) {
  const versionArg = process.argv[2] || 'Unreleased';
  const changelogPath = path.join(__dirname, '../CHANGELOG.md');
  const notes = extractReleaseNotes(changelogPath, versionArg);
  console.log(notes);
}

module.exports = { extractReleaseNotes };
