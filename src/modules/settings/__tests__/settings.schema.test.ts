import { describe, expect, it } from 'vitest';
import { shippingSettingsSchema, storeSettingsSchema } from '../settings.schema.js';

// Pure Zod validation: no database, no network. Covers the Low findings L-S2
// (admin/backend store-field alignment) and L-S3 (shipping zone bounds).

const validStore = () => ({
  name: 'Your Store',
  tagline: { en: 'Handmade in Jaipur', hi: '' },
  logoId: null,
  contact: { email: 'owner@yourstore.example', phone: '+91 98765 43210', address: 'Jaipur, Rajasthan', hours: { en: '9–6', hi: '' } },
  social: { instagram: 'https://instagram.com/yourstore', pinterest: '', facebook: '', youtube: '' },
  handlingDays: { min: 1, max: 3 },
  maxQtyPerLine: 10,
  lowStockThreshold: 5,
});

const validShipping = () => ({
  zones: [
    {
      name: 'India',
      countries: ['IN'],
      standard: { enabled: true, rate: 500, minDays: 3, maxDays: 5 },
      express: { enabled: false, rate: 1500, minDays: 1, maxDays: 2 },
    },
  ],
  unsupportedMessage: { en: 'We do not ship there yet.', hi: '' },
  freeShippingThreshold: null,
});

describe('storeSettingsSchema (L-S2)', () => {
  it('accepts the aligned store fields', () => {
    expect(storeSettingsSchema.parse(validStore())).toMatchObject({ name: 'Your Store' });
  });

  it('requires the contact email (the admin form does too)', () => {
    const bad = validStore();
    bad.contact.email = '';
    expect(() => storeSettingsSchema.parse(bad)).toThrow();
  });

  it('rejects a phone over 30 characters (was 40 vs the admin form’s 30)', () => {
    const bad = validStore();
    bad.contact.phone = '1'.repeat(31);
    expect(() => storeSettingsSchema.parse(bad)).toThrow();
    const ok = validStore();
    ok.contact.phone = '1'.repeat(30);
    expect(() => storeSettingsSchema.parse(ok)).not.toThrow();
  });

  it('rejects an address over 240 characters (was 300 vs the admin form’s 240)', () => {
    const bad = validStore();
    bad.contact.address = 'a'.repeat(241);
    expect(() => storeSettingsSchema.parse(bad)).toThrow();
  });

  it('rejects http social links (https-only, like the admin form)', () => {
    const bad = validStore();
    bad.social.instagram = 'http://instagram.com/yourstore';
    expect(() => storeSettingsSchema.parse(bad)).toThrow();
    const ok = validStore();
    ok.social.instagram = 'https://instagram.com/yourstore';
    expect(() => storeSettingsSchema.parse(ok)).not.toThrow();
  });
});

describe('shippingSettingsSchema (L-S3)', () => {
  it('accepts one zone', () => {
    expect(() => shippingSettingsSchema.parse(validShipping())).not.toThrow();
  });

  it('rejects zero zones (checkout would have nowhere to ship to)', () => {
    const bad = validShipping();
    bad.zones = [];
    expect(() => shippingSettingsSchema.parse(bad)).toThrow(/at least one shipping zone/i);
  });

  it('rejects more than 20 zones', () => {
    const bad = validShipping();
    bad.zones = Array.from({ length: 21 }, (_, i) => ({ ...validShipping().zones[0], name: `Zone ${i}` }));
    expect(() => shippingSettingsSchema.parse(bad)).toThrow(/at most 20/i);
  });
});
