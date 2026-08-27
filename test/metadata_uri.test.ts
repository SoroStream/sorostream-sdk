/**
 * Tests for issue #388: buildMetadataUri and parseMetadataUri helpers
 */
import { describe, it, expect } from 'vitest';
import { buildMetadataUri, parseMetadataUri } from '../src/utils.js';

describe('Issue #388 — buildMetadataUri', () => {
  it('returns empty string for empty fields object', () => {
    expect(buildMetadataUri({})).toBe('');
  });

  it('returns empty string when all values are undefined', () => {
    expect(buildMetadataUri({ label: undefined, tag: undefined })).toBe('');
  });

  it('returns empty string when all values are empty strings', () => {
    expect(buildMetadataUri({ label: '', tag: '' })).toBe('');
  });

  it('builds URI with a single field', () => {
    expect(buildMetadataUri({ label: 'Q3 payout' })).toBe(
      'sorostream:v1?label=Q3%20payout',
    );
  });

  it('builds URI with multiple fields', () => {
    const uri = buildMetadataUri({ label: 'Q3 payout', tag: 'payroll' });
    expect(uri).toBe('sorostream:v1?label=Q3%20payout&tag=payroll');
  });

  it('URL-encodes special characters in values', () => {
    const uri = buildMetadataUri({ url: 'https://example.com/invoice?id=42&v=1' });
    expect(uri).toContain('url=');
    expect(uri).not.toContain('?id=42'); // must be encoded
    expect(uri).toContain('https%3A%2F%2F');
  });

  it('URL-encodes special characters in keys', () => {
    const uri = buildMetadataUri({ 'my key': 'value' });
    expect(uri).toContain('my%20key=value');
  });

  it('includes all known fields', () => {
    const uri = buildMetadataUri({
      label: 'test',
      url: 'https://example.com',
      tag: 'grant',
      namespace: 'org-1',
    });
    expect(uri).toContain('label=test');
    expect(uri).toContain('tag=grant');
    expect(uri).toContain('namespace=org-1');
  });

  it('starts with "sorostream:v1?"', () => {
    const uri = buildMetadataUri({ label: 'hello' });
    expect(uri.startsWith('sorostream:v1?')).toBe(true);
  });

  it('handles extra caller-defined keys', () => {
    const uri = buildMetadataUri({ invoiceId: 'INV-001', costCenter: 'CC42' });
    expect(uri).toContain('invoiceId=INV-001');
    expect(uri).toContain('costCenter=CC42');
  });
});

describe('Issue #388 — parseMetadataUri', () => {
  it('returns empty object for empty string', () => {
    expect(parseMetadataUri('')).toEqual({});
  });

  it('returns empty object for non-sorostream URI', () => {
    expect(parseMetadataUri('https://example.com?foo=bar')).toEqual({});
  });

  it('returns empty object for sorostream URI without query string', () => {
    expect(parseMetadataUri('sorostream:v1')).toEqual({});
  });

  it('parses a single field', () => {
    expect(parseMetadataUri('sorostream:v1?label=Q3%20payout')).toEqual({
      label: 'Q3 payout',
    });
  });

  it('parses multiple fields', () => {
    const result = parseMetadataUri('sorostream:v1?label=Q3%20payout&tag=payroll');
    expect(result).toEqual({ label: 'Q3 payout', tag: 'payroll' });
  });

  it('decodes URL-encoded values', () => {
    const result = parseMetadataUri(
      'sorostream:v1?url=https%3A%2F%2Fexample.com',
    );
    expect(result.url).toBe('https://example.com');
  });

  it('ignores malformed pairs without "="', () => {
    const result = parseMetadataUri('sorostream:v1?label=hello&badpair&tag=payroll');
    expect(result.label).toBe('hello');
    expect(result.tag).toBe('payroll');
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('round-trips through buildMetadataUri → parseMetadataUri', () => {
    const original = {
      label: 'Q3 2026 grant',
      tag: 'grant/stellar',
      url: 'https://example.com/contract?id=99',
      namespace: 'org:test',
    };
    const uri = buildMetadataUri(original);
    const parsed = parseMetadataUri(uri);
    expect(parsed).toEqual(original);
  });

  it('exported from the main index', async () => {
    const { buildMetadataUri: fn1, parseMetadataUri: fn2 } = await import('../src/index.js');
    expect(typeof fn1).toBe('function');
    expect(typeof fn2).toBe('function');
  });
});
