import { describe, expect, it } from 'vitest';
import { osFrontend } from './ui.js';

describe('OS executive frontend', () => {
  it('parses embedded browser JavaScript', () => {
    const match=osFrontend.match(/<script>([\s\S]*?)<\/script>/i);
    expect(match?.[1]).toBeTruthy();
    expect(()=>new Function(match![1]!)).not.toThrow();
  });

  it('contains executive, reports, audit and backup actions', () => {
    expect(osFrontend).toContain('Executive Command Centre');
    expect(osFrontend).toContain("page('customer-organisations')");
    expect(osFrontend).toContain("p==='reports'");
    expect(osFrontend).toContain("p==='audit-assurance'");
    expect(osFrontend).toContain("p==='backups'");
    expect(osFrontend).toContain('/v1/assurance/backups/run-all');
    expect(osFrontend).toContain('/v1/assurance/reports');
    expect(osFrontend).toContain('/v1/assurance/audit/verify');
  });
});
