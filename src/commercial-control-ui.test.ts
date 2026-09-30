import { describe, expect, it } from 'vitest';
import { commercialControlFrontend } from './commercial-control-ui.js';

describe('commercial control browser script', () => {
  it('parses as valid browser JavaScript', () => {
    const match = commercialControlFrontend.match(/<script>([\s\S]*?)<\/script>/i);
    expect(match?.[1]).toBeTruthy();
    expect(() => new Function(match![1]!)).not.toThrow();
  });

  it('contains the core click bindings', () => {
    expect(commercialControlFrontend).toContain('E("newSchool").onclick=openNewSchool');
    expect(commercialControlFrontend).toContain('document.querySelector(".nav").onclick');
    expect(commercialControlFrontend).toContain('E("refresh").onclick');
  });
});
