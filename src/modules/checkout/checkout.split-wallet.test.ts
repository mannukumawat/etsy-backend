import { describe, expect, it } from 'vitest';
import { placeOrderSchema } from './checkout.schema.js';
import { splitWalletPayment } from './wallet-split.js';

// Unit tests for the split-wallet fix (C1). These import only zod + a pure helper, so they
// run without a database or Razorpay credentials. The DB-backed scenarios — partial exceeding
// the real wallet balance, and a Razorpay order whose amount does not equal the remainder —
// are enforced in order-placement.service.ts (getBalance + verifyRazorpayOrderAmount) and in
// checkout.routes.ts, and still need a Razorpay-sandbox run against a test DB (see report).

const baseOrder = {
  idempotencyKey: 'idem_test123',
  lines: [{ productId: 'prod-1', variantId: 'var-1', quantity: 1 }],
  currency: 'INR' as const,
  email: 'buyer@example.test',
  address: {
    fullName: 'Test Buyer',
    phoneCountry: 'IN',
    phone: '9876543210',
    country: 'IN',
    line1: '1 Test Street',
  },
  shippingMethodId: 'standard' as const,
  paymentMethod: 'card' as const,
};

describe('splitWalletPayment', () => {
  it('charges Razorpay only the remainder for a partial wallet payment', () => {
    expect(splitWalletPayment(10000, 4000)).toEqual({ walletMinor: 4000, razorpayMinor: 6000, isFullWallet: false, isSplitWallet: true });
  });

  it('charges nothing to Razorpay when the partial equals the total (full wallet)', () => {
    expect(splitWalletPayment(10000, 10000)).toEqual({ walletMinor: 10000, razorpayMinor: 0, isFullWallet: true, isSplitWallet: false });
  });

  it('charges the full total to Razorpay when there is no wallet payment', () => {
    expect(splitWalletPayment(10000, 0)).toEqual({ walletMinor: 0, razorpayMinor: 10000, isFullWallet: false, isSplitWallet: false });
  });

  it('rejects a partial wallet amount above the order total', () => {
    expect(() => splitWalletPayment(10000, 10001)).toThrow(/cannot exceed the order total/);
  });

  it('rejects a negative wallet amount', () => {
    expect(() => splitWalletPayment(10000, -1)).toThrow(/cannot be negative/);
  });
});

describe('placeOrderSchema wallet fields', () => {
  it('accepts a partial wallet payment with card/UPI', () => {
    const parsed = placeOrderSchema.parse({ ...baseOrder, walletPartialMinor: 4000 });
    expect(parsed.walletPartialMinor).toBe(4000);
  });

  it('accepts a partial wallet amount equal to the total (normalised to full wallet at placement)', () => {
    const parsed = placeOrderSchema.parse({ ...baseOrder, walletPartialMinor: 10000 });
    expect(parsed.walletPartialMinor).toBe(10000);
  });

  it('rejects a negative partial wallet amount', () => {
    expect(() => placeOrderSchema.parse({ ...baseOrder, walletPartialMinor: -100 })).toThrow();
  });

  it('rejects both a full and a partial wallet amount in one order', () => {
    expect(() => placeOrderSchema.parse({ ...baseOrder, walletAmountMinor: 5000, walletPartialMinor: 4000 })).toThrow(/either a full wallet payment or a partial/);
  });

  it('rejects a partial wallet amount with paymentMethod wallet (use walletAmountMinor instead)', () => {
    expect(() => placeOrderSchema.parse({ ...baseOrder, paymentMethod: 'wallet', walletPartialMinor: 4000 })).toThrow();
  });

  it('still accepts a full wallet payment without any partial', () => {
    const parsed = placeOrderSchema.parse({ ...baseOrder, paymentMethod: 'wallet', walletAmountMinor: 10000 });
    expect(parsed.walletAmountMinor).toBe(10000);
    expect(parsed.walletPartialMinor).toBeUndefined();
  });
});
