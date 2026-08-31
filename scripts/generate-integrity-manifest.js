#!/usr/bin/env node
/**
 * Generates a SHA-256 integrity manifest for the built SDK bundle (Issue #526).
 *
 * Run after `npm run build` to produce `dist/integrity-manifest.json`.
 * The manifest lists every file in the dist directory together with its
 * SHA-256 checksum and size in bytes, letting downstream consumers verify
 * the bundle has not been tampered with.
 *
 * The generated file itself is excluded from subsequent manifest runs
 * to keep the hash stable.
 *
 * Usage:
 *   node scripts/generate-integrity-manifest.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(DIST_DIR, 'integrity-manifest.json');
const PKG = require(path.join(ROOT, 'package.json'));

/** Compute the hex SHA-256 digest of a Buffer. */
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Recursively collect file entries from a directory. */
function walk(dir, base, results) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    // Skip the manifest file itself so the hash stays stable
    if (full === OUT_FILE) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, base, results);
    } else {
      const content = fs.readFileSync(full);
      results.push({
        file: path.relative(base, full).replace(/\\/g, '/'),
        sha256: sha256(content),
        size: stat.size,
      });
    }
  }
}

// Guard: require a prior build
if (!fs.existsSync(DIST_DIR)) {
  console.warn('[integrity] dist/ not found — run `npm run build` first.');
  process.exit(0);
}

const files = [];
walk(DIST_DIR, DIST_DIR, files);
files.sort((a, b) => a.file.localeCompare(b.file));

const manifest = {
  package: PKG.name,
  version: PKG.version,
  generatedAt: new Date().toISOString(),
  files,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[integrity] Manifest written → ${path.relative(ROOT, OUT_FILE)} (${files.length} file${files.length === 1 ? '' : 's'})`);
