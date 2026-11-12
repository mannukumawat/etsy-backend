import { Router } from 'express';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { notFound, route } from '../http.js';
import { ORDER_INCLUDE, toAdminCustomerAccount, toAdminOrder, toSavedAddress } from '../mappers.js';

// Read-only: customers are derived entirely from accounts + orders, with no separate mutation API.
// Matches admin/src/services/salesServices.ts `summaries()`/`get()` exactly, including the rule that
// guest orders are grouped by email but NEVER merged into an account that happens to share that email.

export const adminCustomersRouter = Router();
adminCustomersRouter.use(requireOwner);

const wasPaid = (status: string) => status === 'paid' || status === 'partially_refunded' || status === 'refunded';
const netPaid = (o: { paymentStatus: string; total: number; refundedTotal: number }) => (wasPaid(o.paymentStatus) ? o.total - o.refundedTotal : 0);
const toUsd = (amount: number, rate: number) => (rate > 0 ? Math.round(amount / rate) : 0);
const guestId = (email: string) => `guest:${email.toLowerCase()}`;

function summarize(id: string, kind: 'account' | 'guest', name: string, email: string, phone: string, createdAt: string | null, orders: Array<{ paymentStatus: string; total: number; refundedTotal: number; rateSnapshotJson: string; createdAt: Date }>) {
  return {
    id,
    kind,
    name,
    email,
    phone: phone || null,
    createdAt,
    orderCount: orders.length,
    paidOrderCount: orders.filter((o) => wasPaid(o.paymentStatus)).length,
    spentUsd: orders.reduce((s, o) => s + toUsd(netPaid(o), (JSON.parse(o.rateSnapshotJson) as { rate: number }).rate), 0),
    lastOrderAt: orders.reduce<string | null>((max, o) => {
      const iso = o.createdAt.toISOString();
      return !max || iso > max ? iso : max;
    }, null),
  };
}

async function allSummaries() {
  const [customers, orders] = await Promise.all([
    prisma.customer.findMany(),
    prisma.order.findMany({ select: { customerId: true, customerKind: true, customerName: true, customerEmail: true, customerPhone: true, paymentStatus: true, total: true, refundedTotal: true, rateSnapshotJson: true, createdAt: true } }),
  ]);

  const accounts = customers.map((c) => {
    const own = orders.filter((o) => o.customerKind === 'account' && o.customerId === c.id);
    return summarize(c.id, 'account', c.name, c.email, c.phone, c.createdAt.toISOString(), own);
  });

  const guestGroups = new Map<string, typeof orders>();
  for (const o of orders.filter((o) => o.customerKind === 'guest')) {
    const key = o.customerEmail.toLowerCase();
    guestGroups.set(key, [...(guestGroups.get(key) ?? []), o]);
  }
  const guests = [...guestGroups.entries()].map(([email, group]) => {
    const latest = [...group].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return summarize(guestId(email), 'guest', latest.customerName, latest.customerEmail, latest.customerPhone, null, group);
  });

  return [...accounts, ...guests];
}

const SORT_KEYS: Record<string, (c: Awaited<ReturnType<typeof allSummaries>>[number]) => string | number> = {
  name: (c) => c.name.toLowerCase(),
  spent: (c) => c.spentUsd,
  orders: (c) => c.orderCount,
  last: (c) => c.lastOrderAt ?? '',
  joined: (c) => c.createdAt ?? '',
};

adminCustomersRouter.get(
  '/',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const kind = String(req.query.kind ?? '').trim();
    const sortKey = SORT_KEYS[String(req.query.sort ?? '')] ? String(req.query.sort) : 'last';
    const dir = req.query.dir === 'asc' ? 1 : -1;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));

    let items = await allSummaries();
    if (kind) items = items.filter((c) => c.kind === kind);
    if (q) items = items.filter((c) => `${c.name} ${c.email} ${c.phone ?? ''}`.toLowerCase().includes(q));

    const sortFn = SORT_KEYS[sortKey];
    items.sort((a, b) => {
      const av = sortFn(a);
      const bv = sortFn(b);
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });

    const total = items.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const clampedPage = Math.min(page, pageCount);
    const start = (clampedPage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    res.json({ items: pageItems, total, page: clampedPage, pageCount, pageSize });
  }),
);

adminCustomersRouter.get(
  '/:id',
  route(async (req, res) => {
    const summary = (await allSummaries()).find((c) => c.id === req.params.id);
    if (!summary) throw notFound('Customer not found.');

    const account = summary.kind === 'account' ? await prisma.customer.findUnique({ where: { id: req.params.id } }) : null;
    const addresses = account ? await prisma.customerAddress.findMany({ where: { customerId: account.id }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }) : [];
    const orderRows = await prisma.order.findMany({
      where:
        summary.kind === 'account'
          ? { customerKind: 'account', customerId: req.params.id }
          : { customerKind: 'guest', customerEmail: { equals: summary.email } },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ summary, account: account ? toAdminCustomerAccount(account, addresses.map(toSavedAddress)) : null, orders: orderRows.map((o) => toAdminOrder(o)) });
  }),
);
