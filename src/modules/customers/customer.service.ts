import { prisma } from '../../shared/database/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors/http-error.js';
import { loadLineExtras } from '../orders/order-line-extras.service.js';
import { ORDER_INCLUDE, toStorefrontOrder } from '../orders/order.mapper.js';
import { toSavedAddress } from './customer.mapper.js';
import type { CustomerAddressInput, CustomerProfileInput } from './customer.schema.js';

// --- profile --------------------------------------------------------------------------------------

export async function updateCustomerProfile(customerId: string, input: CustomerProfileInput) {
  const email = input.email.trim().toLowerCase();
  const other = await prisma.customer.findUnique({ where: { email } });
  if (other && other.id !== customerId) throw conflict('An account with this email already exists.', [{ path: 'email', message: 'Already registered.' }]);
  return prisma.customer.update({
    where: { id: customerId },
    data: {
      name: input.name.trim(),
      email,
      phone: input.phone,
      avatarUrl: input.avatarUrl,
      gender: input.gender,
      languages: input.languages,
      occupation: input.occupation,
      pincode: input.pincode,
      city: input.city,
      state: input.state,
      dateOfBirth: input.dateOfBirth,
      maritalStatus: input.maritalStatus,
      numberOfKids: input.numberOfKids,
      education: input.education,
      monthlyIncome: input.monthlyIncome,
    },
  });
}

// --- addresses ------------------------------------------------------------------------------------

export async function listCustomerAddresses(customerId: string) {
  const rows = await prisma.customerAddress.findMany({ where: { customerId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  return rows.map(toSavedAddress);
}

/** Upsert by id (matches the storefront's `saveAddress(userId, {..., id?})`). The first address, or
 *  any address explicitly marked default, becomes the sole default. Returns the refreshed list. */
export async function saveCustomerAddress(customerId: string, id: string | undefined, input: CustomerAddressInput) {
  if (id) {
    const existing = await prisma.customerAddress.findUnique({ where: { id } });
    if (!existing || existing.customerId !== customerId) throw notFound('Address not found.');
  }

  await prisma.$transaction(async (tx) => {
    const existingCount = await tx.customerAddress.count({ where: { customerId } });
    const willBeDefault = input.isDefault || existingCount === 0;
    if (willBeDefault) await tx.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });

    const data = { ...input, isDefault: willBeDefault, customerId };
    if (id) await tx.customerAddress.update({ where: { id }, data });
    else await tx.customerAddress.create({ data });
  });

  return listCustomerAddresses(customerId);
}

/** Returns the refreshed list. */
export async function deleteCustomerAddress(customerId: string, addressId: string) {
  const existing = await prisma.customerAddress.findUnique({ where: { id: addressId } });
  if (!existing || existing.customerId !== customerId) throw notFound('Address not found.');
  await prisma.customerAddress.delete({ where: { id: addressId } });
  // Promote another address to default if the deleted one was it, matching the mock's behaviour.
  if (existing.isDefault) {
    const next = await prisma.customerAddress.findFirst({ where: { customerId }, orderBy: { createdAt: 'asc' } });
    if (next) await prisma.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  return listCustomerAddresses(customerId);
}

// --- wishlist -------------------------------------------------------------------------------------

export async function listCustomerWishlist(customerId: string) {
  const rows = await prisma.wishlistItem.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({ productId: r.productId, variantId: r.variantId ?? undefined, addedAt: r.createdAt.toISOString() }));
}

export async function toggleWishlistItem(customerId: string, productId: string, variantId: string | undefined) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw badRequest('Product not found.', [{ path: 'productId', message: 'Not found.' }]);

  const existing = await prisma.wishlistItem.findFirst({ where: { customerId, productId, variantId: variantId ?? null } });
  let saved: boolean;
  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });
    saved = false;
  } else {
    await prisma.wishlistItem.create({ data: { customerId, productId, variantId: variantId ?? null } });
    saved = true;
  }
  return { saved, items: await listCustomerWishlist(customerId) };
}

/** Returns the refreshed list. */
export async function removeWishlistProduct(customerId: string, productId: string) {
  await prisma.wishlistItem.deleteMany({ where: { customerId, productId } });
  return listCustomerWishlist(customerId);
}

// --- order history (private: only the signed-in customer's own orders) ----------------------------

export async function listCustomerOrders(customerId: string) {
  const rows = await prisma.order.findMany({ where: { customerId }, include: ORDER_INCLUDE, orderBy: { createdAt: 'desc' } });
  const extras = await loadLineExtras(rows.map((r) => r.id));
  return rows.map((r) => toStorefrontOrder(r, extras));
}

export async function getCustomerOrder(customerId: string, orderId: string) {
  const row = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  if (!row || row.customerId !== customerId) throw notFound('Order not found.');
  return toStorefrontOrder(row, await loadLineExtras([row.id]));
}
