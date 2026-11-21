import { describe, expect, it } from 'vitest';

// Country-specific payments: UPI is India-only (backend enforcement in placeOrder
// and create-order; the storefront filter is a separate agent's job).

import { assertPaymentMethodForCountry } from '../payment.service.js';

describe('assertPaymentMethodForCountry', () => {
  it('rejects UPI for any shipping country other than India', () => {
    expect(() => assertPaymentMethodForCountry('upi', 'US')).toThrow('UPI is only available for payments from India.');
    expect(() => assertPaymentMethodForCountry('upi', 'DE')).toThrow('UPI is only available for payments from India.');
    expect(() => assertPaymentMethodForCountry('upi', '')).toThrow('UPI is only available for payments from India.');
  });

  it('allows UPI for India (any case) and other methods anywhere', () => {
    expect(() => assertPaymentMethodForCountry('upi', 'IN')).not.toThrow();
    expect(() => assertPaymentMethodForCountry('upi', 'in')).not.toThrow();
    expect(() => assertPaymentMethodForCountry('card', 'US')).not.toThrow();
    expect(() => assertPaymentMethodForCountry('wallet', 'DE')).not.toThrow();
  });
});
