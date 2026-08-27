// @ts-check
'use strict';

const VALID_CATEGORIES = new Set([
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
]);

/**
 * Validates a single changelog line.
 * Returns null if valid, or an error string describing the problem.
 * @param {string} line
 * @returns {string | null}
 */
function validateChangelogLine(line) {
  if (line.startsWith('### ')) {
    const category = line.slice(4).trim();
    if (!VALID_CATEGORIES.has(category)) {
      return `Unexpected changelog category: "${category}". Expected one of: ${[...VALID_CATEGORIES].join(', ')}`;
    }
    return null;
  }

  if (line.startsWith('- ')) {
    if (!/\(#\d+\)/.test(line)) {
      return `Expected changelog entries to reference an issue or PR number, e.g. "(#123)"`;
    }
    return null;
  }

  return null;
}

/**
 * Collects validation errors from a changelog git diff string.
 * @param {string} diff
 * @returns {Array<{ line: string; error: string }>}
 */
function collectChangelogValidationErrors(diff) {
  const errors = [];
  for (const raw of diff.split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    const error = validateChangelogLine(line);
    if (error) {
      errors.push({ line, error });
    }
  }
  return errors;
}

module.exports = { validateChangelogLine, collectChangelogValidationErrors };
