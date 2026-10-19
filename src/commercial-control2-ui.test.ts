import { describe, expect, it } from 'vitest';
import { commercialControlFrontend } from './commercial-control2-ui.js';

describe('live commercial control admin access', () => {
  it('parses as valid browser JavaScript', () => {
    const match = commercialControlFrontend.match(/<script>([\s\S]*?)<\/script>/i);
    expect(match?.[1]).toBeTruthy();
    expect(() => new Function(match![1]!)).not.toThrow();
  });

  it('uses the canonical School admin reset flow', () => {
    expect(commercialControlFrontend).toContain('Organisation Admin Email');
    expect(commercialControlFrontend).toContain('Generate Password Reset Link');
    expect(commercialControlFrontend).toContain("/v1/commercial-control/schools/'+id+'/admin-invite");
    expect(commercialControlFrontend).toContain('x.resetUrl||x.setupUrl');
    expect(commercialControlFrontend).toContain('x.expiresInMinutes');
    expect(commercialControlFrontend).toContain('Open Password Reset');
    expect(commercialControlFrontend).not.toContain("Valid for '+x.expiresInHours+' hours");
  });

  it('supports an administrator-assigned temporary School password requiring a change', () => {
    expect(commercialControlFrontend).toContain('Set New Admin');
    expect(commercialControlFrontend).toContain('id="newAdminPassword"');
    expect(commercialControlFrontend).toContain('id="newAdminPasswordConfirm"');
    expect(commercialControlFrontend).toContain("/v1/commercial-control/schools/'+id+'/admin");
    expect(commercialControlFrontend).toContain('password:p');
    expect(commercialControlFrontend).toContain('They must change it at first sign-in.');
  });

  it('shows temporary administrator credentials after paid-invoice school creation', () => {
    expect(commercialControlFrontend).toContain('temporaryPassword');
    expect(commercialControlFrontend).toContain('copyCreated');
    expect(commercialControlFrontend).toContain('Validate Invoice');
    expect(commercialControlFrontend).toContain('School Setup Invoices');
  });
});
