import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  collectChangelogValidationErrors,
  validateChangelogLine,
} = require('../scripts/check-changelog-format.js');

describe('changelog format validation', () => {
  it('accepts Keep a Changelog style entries', () => {
    expect(validateChangelogLine('### Added')).toBeNull();
    expect(validateChangelogLine('- Add zero cliff duration regression test (#152)')).toBeNull();
  });

  it('rejects invalid categories and entry formats', () => {
    expect(validateChangelogLine('### Misc')).toContain('Unexpected changelog category');
    expect(validateChangelogLine('- Add zero cliff duration regression test')).toContain(
      'Expected changelog entries',
    );
  });

  it('collects errors from a changelog diff', () => {
    const diff = [
      'diff --git a/CHANGELOG.md b/CHANGELOG.md',
      '+++ b/CHANGELOG.md',
      '+### Added',
      '+- Add zero cliff duration regression test (#152)',
      '+### Misc',
      '+- Add invalid entry',
    ].join('\n');

    const errors = collectChangelogValidationErrors(diff);
    expect(errors).toHaveLength(2);
    expect(errors[0].error).toContain('Unexpected changelog category');
    expect(errors[1].error).toContain('Expected changelog entries');
  });
});
