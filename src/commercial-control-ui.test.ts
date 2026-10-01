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
    expect(commercialControlFrontend).toContain('id="extendLicense"');
    expect(commercialControlFrontend).toContain('E("extendLicense").onclick');
    expect(commercialControlFrontend).toContain('data-license="active"');
    expect(commercialControlFrontend).toContain('data-license="grace"');
    expect(commercialControlFrontend).toContain('data-license="suspended"');
    expect(commercialControlFrontend).toContain('data-license="expired"');
    expect(commercialControlFrontend).toContain('data-license="cancelled"');
    expect(commercialControlFrontend).toContain('querySelectorAll("[data-license]")');
    expect(commercialControlFrontend).toContain('E("changePlan").onclick');
    expect(commercialControlFrontend).toContain('E("syncLicense").onclick');
    expect(commercialControlFrontend).toContain('E("retryProvision").onclick');
    expect(commercialControlFrontend).toContain('id="setSchoolAdmin"');
    expect(commercialControlFrontend).toContain('E("setSchoolAdmin").onclick');
    expect(commercialControlFrontend).toContain('id="resetSchoolAdmin"');
    expect(commercialControlFrontend).toContain('E("resetSchoolAdmin").onclick');
    expect(commercialControlFrontend).toContain('/v1/commercial-control/schools/"+id+"/admin');
    expect(commercialControlFrontend).toContain('E("issueInvoice").onclick');
  });
});
