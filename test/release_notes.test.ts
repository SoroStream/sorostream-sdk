import { describe, it, expect } from 'vitest';
import { extractReleaseNotes } from '../scripts/extract-release-notes.js';
import { join } from 'node:path';

describe('extract-release-notes.js (#658)', () => {
  const changelogPath = join(__dirname, '../CHANGELOG.md');

  it('extracts Unreleased section from CHANGELOG.md', () => {
    const notes = extractReleaseNotes(changelogPath, 'Unreleased');
    expect(notes).toBeDefined();
    expect(notes).not.toContain('No release notes found');
    expect(notes).toMatch(/Added|Fixed|Changed|Security/);
  });

  it('handles non-existent version gracefully', () => {
    const notes = extractReleaseNotes(changelogPath, 'v99.99.99');
    expect(notes).toContain('No release notes found for version v99.99.99');
  });
});
