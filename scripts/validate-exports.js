#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const packageJsonPath = path.resolve(process.cwd(), 'package.json');

if (!fs.existsSync(packageJsonPath)) {
  console.error('No package.json found.');
  process.exit(1);
}

const pkg = require(packageJsonPath);

if (!pkg.exports) {
  console.log('No exports map found in package.json.');
  process.exit(0);
}

let hasError = false;

function validatePath(exportPath, filePath) {
  if (typeof filePath === 'string') {
    // Subpath pattern exports (e.g. "./schemas/*") aren't literal files —
    // there's nothing to resolve against the filesystem directly.
    if (filePath.includes('*')) {
      const dir = path.resolve(process.cwd(), filePath.split('*')[0]);
      if (!fs.existsSync(dir)) {
        console.error(
          `Export validation failed: Directory not found for export pattern "${exportPath}" at "${filePath}"`,
        );
        hasError = true;
      }
      return;
    }
    const resolvedPath = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(
        `Export validation failed: File not found for export path "${exportPath}" at "${filePath}"`,
      );
      hasError = true;
    }
  } else if (typeof filePath === 'object' && filePath !== null) {
    for (const [condition, conditionPath] of Object.entries(filePath)) {
      validatePath(`${exportPath}.${condition}`, conditionPath);
    }
  }
}

for (const [exportPath, value] of Object.entries(pkg.exports)) {
  validatePath(exportPath, value);
}

if (hasError) {
  console.error('One or more export paths are broken.');
  process.exit(1);
}

console.log('All export paths validated successfully.');
