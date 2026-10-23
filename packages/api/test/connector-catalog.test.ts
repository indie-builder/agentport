import { connectorCatalogSchema } from '@agentport/shared';
import { describe, expect, it } from 'vitest';
import { connectorCatalog } from '../src/features/servers/connector-catalog-data.js';

describe('connector catalog seed', () => {
  it('validates against the shared schema', () => {
    expect(() => connectorCatalogSchema.parse(connectorCatalog)).not.toThrow();
  });

  it('every entry records provenance and is unique', () => {
    const slugs = new Set<string>();
    for (const item of connectorCatalog) {
      expect(item.sourceUrl, item.slug).toMatch(/^https?:\/\//);
      expect(item.reviewedAt, item.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(slugs.has(item.slug), `duplicate slug ${item.slug}`).toBe(false);
      slugs.add(item.slug);
    }
  });

  it('http entries have a url; stdio entries have a command; no secret values', () => {
    for (const item of connectorCatalog) {
      if (item.kind === 'http') expect(item.url, item.slug).toMatch(/^https?:\/\//);
      if (item.kind === 'stdio') expect(item.command, item.slug).toBeTruthy();
      // envKeys are names only — the schema has no field for values at all.
      expect(JSON.stringify(item)).not.toMatch(/"(token|secret|password|apikey|api_key)":/i);
    }
  });
});
