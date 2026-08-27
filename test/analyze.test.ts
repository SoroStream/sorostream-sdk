import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const CLI_DIR = path.resolve(__dirname, '../packages/cli');
const TMP_DIR = path.resolve(__dirname, '../.tmp-analyze-test');

describe('sorostream analyze CLI', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TMP_DIR, 'entry.ts'),
      `export function hello(name: string): string { return "Hello, " + name; }\nexport const x = 42;\n`,
    );
  });

  afterAll(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('produces a markdown report with module sizes', () => {
    const output = execSync(`npx tsx src/analyze.ts analyze ${path.join(TMP_DIR, 'entry.ts')}`, {
      cwd: CLI_DIR,
      encoding: 'utf-8',
    });
    expect(output).toContain('Bundle Analysis Report');
    expect(output).toContain('Total Size:');
    expect(output).toContain('Module Breakdown');
    expect(output).toContain('entry.ts');
  });

  it('generates HTML treemap when --html is passed', () => {
    const output = execSync(
      `npx tsx src/analyze.ts analyze ${path.join(TMP_DIR, 'entry.ts')} --html`,
      { cwd: CLI_DIR, encoding: 'utf-8' },
    );
    expect(output).toContain('HTML treemap saved to');
    const htmlPath = path.join(TMP_DIR, 'bundle-treemap.html');
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, 'utf-8');
    expect(html).toContain('Bundle Analysis Treemap');
    expect(html).toContain('entry.ts');
  });

  it('exits with error for missing entrypoint', () => {
    try {
      execSync(`npx tsx src/analyze.ts analyze ${path.join(TMP_DIR, 'nonexistent.ts')}`, {
        cwd: CLI_DIR,
        encoding: 'utf-8',
      });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(1);
    }
  });
});
