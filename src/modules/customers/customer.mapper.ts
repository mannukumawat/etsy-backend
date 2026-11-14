export function toCustomerPublic(c: { id: string; name: string; email: string; phone: string; createdAt: Date }) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone || undefined, createdAt: c.createdAt.toISOString(), isDemoAccount: false };
}

/** admin/src/types Customer shape (distinct from the storefront's User: `phone` is nullable rather
 *  than optional, and it carries addresses). `marketingOptIn` has no backing column yet — there is no
 *  opt-in checkbox anywhere in the real registration/profile flow — so it is reported as false. */
export function toAdminCustomerAccount(c: { id: string; name: string; email: string; phone: string; createdAt: Date }, addresses: ReturnType<typeof toSavedAddress>[]) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone || null, createdAt: c.createdAt.toISOString(), marketingOptIn: false, addresses };
}

export function toSavedAddress(a: {
  id: string; label: string; isDefault: boolean; fullName: string; phoneCountry: string; phone: string;
  country: string; line1: string; line2: string; city: string; region: string; postalCode: string;
}) {
  return {
    id: a.id,
    label: a.label,
    isDefault: a.isDefault,
    fullName: a.fullName,
    phoneCountry: a.phoneCountry,
    phone: a.phone,
    country: a.country,
    line1: a.line1,
    line2: a.line2 || undefined,
    city: a.city || undefined,
    region: a.region || undefined,
    postalCode: a.postalCode || undefined,
  };
}
