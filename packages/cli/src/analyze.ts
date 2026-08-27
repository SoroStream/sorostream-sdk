#!/usr/bin/env node
import { Command } from 'commander';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

export interface AnalyzeOptions {
  entrypoint: string;
  html: boolean;
  outputDir?: string;
}

interface ModuleInfo {
  path: string;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function cmdAnalyze(opts: AnalyzeOptions): Promise<void> {
  const entrypointPath = path.resolve(opts.entrypoint);

  if (!fs.existsSync(entrypointPath)) {
    throw new Error(`Entrypoint file not found: ${entrypointPath}`);
  }

  console.log(`Analyzing bundle for: ${entrypointPath}`);

  const result = await esbuild.build({
    entryPoints: [entrypointPath],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    minify: false,
    treeShaking: true,
    logLevel: 'silent',
  });

  const metafile = result.metafile;
  if (!metafile) {
    throw new Error('Failed to generate metafile');
  }

  const modules: ModuleInfo[] = [];
  let totalSize = 0;

  for (const [filePath, info] of Object.entries(metafile.inputs)) {
    const size = info.bytes;
    totalSize += size;
    modules.push({ path: filePath, size });
  }

  modules.sort((a, b) => b.size - a.size);

  // Markdown report
  const lines: string[] = [];
  lines.push('# Bundle Analysis Report');
  lines.push('');
  lines.push(`**Entrypoint:** \`${entrypointPath}\``);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Total Size:** ${formatBytes(totalSize)}`);
  lines.push('');
  lines.push('## Module Breakdown');
  lines.push('');
  lines.push('| Module | Size | % of Total |');
  lines.push('|--------|------|------------|');

  for (const mod of modules.slice(0, 30)) {
    const percent = ((mod.size / totalSize) * 100).toFixed(1);
    lines.push(`| \`${mod.path}\` | ${formatBytes(mod.size)} | ${percent}% |`);
  }

  if (modules.length > 30) {
    lines.push(`| ... and ${modules.length - 30} more modules | | |`);
  }

  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total Modules:** ${modules.length}`);
  lines.push(`- **Total Bundle Size:** ${formatBytes(totalSize)}`);
  if (modules.length > 0 && modules[0]) {
    lines.push(`- **Largest Module:** \`${modules[0].path}\` (${formatBytes(modules[0].size)})`);
  }

  const markdown = lines.join('\n');
  console.log('\n' + markdown);

  // HTML treemap
  if (opts.html) {
    const outputDir = opts.outputDir || path.dirname(entrypointPath);
    const htmlPath = path.join(outputDir, 'bundle-treemap.html');

    const topModules = modules.slice(0, 30);
    const maxSize = topModules[0]?.size ?? 1;

    const items = topModules
      .map((mod) => {
        const width = Math.max(20, (mod.size / maxSize) * 100);
        const shortPath = path.basename(mod.path);
        return `      <div class="module-bar" style="width: ${width}%" title="${mod.path} (${formatBytes(mod.size)})">
        <span>${shortPath} (${formatBytes(mod.size)})</span>
      </div>`;
      })
      .join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bundle Treemap - ${path.basename(entrypointPath)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #1f2937; }
    .info { background: white; padding: 16px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .treemap { background: white; padding: 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .module-list { margin-top: 16px; }
    .module-bar { background: #3b82f6; color: white; padding: 4px 8px; margin: 2px 0; border-radius: 4px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Bundle Analysis Treemap</h1>
    <div class="info">
      <p><strong>Entrypoint:</strong> ${entrypointPath}</p>
      <p><strong>Total Size:</strong> ${formatBytes(totalSize)}</p>
      <p><strong>Modules:</strong> ${modules.length}</p>
    </div>
    <div class="treemap">
      <h2>Module Sizes (Top 30)</h2>
      <div class="module-list">
${items}
      </div>
    </div>
  </div>
</body>
</html>`;

    fs.writeFileSync(htmlPath, html);
    console.log(`\nHTML treemap saved to: ${htmlPath}`);
  }
}

// Standalone CLI entrypoint when run directly
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('analyze.js') ||
    process.argv[1].endsWith('analyze.ts') ||
    process.argv[1].endsWith('sorostream-analyze'));

if (isMainModule) {
  const program = new Command();

  program
    .name('sorostream-analyze')
    .description('Bundle analysis CLI — reports module sizes and tree-shaking coverage')
    .version('0.1.0');

  program
    .command('analyze')
    .description('Analyze bundle size and tree-shaking coverage for an entrypoint')
    .argument('<entrypoint>', 'Path to the entrypoint file to analyze')
    .option('--html', 'Generate an interactive treemap HTML file', false)
    .option('--output-dir <dir>', 'Directory for output files (default: entrypoint directory)')
    .action(async (entrypoint: string, opts: { html: boolean; outputDir?: string }) => {
      await cmdAnalyze({ entrypoint, html: opts.html, outputDir: opts.outputDir });
    });

  program.parse();
}
