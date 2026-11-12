import { Router } from 'express';
import { z } from 'zod';
import { requireOwner } from '../auth.js';
import { prisma } from '../db.js';
import { notFound, route } from '../http.js';

export const adminContactsRouter = Router();
adminContactsRouter.use(requireOwner);

type RawMsg = {
  id: string; name: string; email: string; subject: string;
  orderNumber: string; message: string; status: string;
  note: string | null; createdAt: Date; updatedAt: Date;
};

function mapMsg(r: RawMsg) {
  return { id: r.id, name: r.name, email: r.email, subject: r.subject, orderNumber: r.orderNumber || null, message: r.message, status: r.status, note: r.note ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

// GET /api/admin/contacts?status=unread&page=1
adminContactsRouter.get(
  '/',
  route(async (req, res) => {
    const status = typeof req.query.status === 'string' && ['unread', 'read', 'replied'].includes(req.query.status) ? req.query.status : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const take = 25;
    const offset = (page - 1) * take;

    const whereClause = status ? `WHERE status = ?` : '';
    const params: unknown[] = status ? [status, take, offset] : [take, offset];

    const rows = await prisma.$queryRawUnsafe<RawMsg[]>(
      `SELECT * FROM contact_messages ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      ...params,
    );
    const [{ total }] = await prisma.$queryRawUnsafe<[{ total: bigint }]>(
      `SELECT COUNT(*) as total FROM contact_messages ${whereClause}`,
      ...(status ? [status] : []),
    );

    res.json({ items: rows.map(mapMsg), total: Number(total), page, pages: Math.ceil(Number(total) / take) });
  }),
);

// GET /api/admin/contacts/:id
adminContactsRouter.get(
  '/:id',
  route(async (req, res) => {
    const [row] = await prisma.$queryRawUnsafe<RawMsg[]>(`SELECT * FROM contact_messages WHERE id = ?`, req.params.id);
    if (!row) throw notFound('Message not found.');
    // Mark as read automatically
    if (row.status === 'unread') {
      await prisma.$executeRawUnsafe(`UPDATE contact_messages SET status = 'read', updatedAt = NOW(3) WHERE id = ?`, row.id);
      row.status = 'read';
    }
    res.json(mapMsg(row));
  }),
);

const updateSchema = z.object({
  status: z.enum(['unread', 'read', 'replied']).optional(),
  note: z.string().max(2000).nullable().optional(),
});

// PATCH /api/admin/contacts/:id
adminContactsRouter.patch(
  '/:id',
  route(async (req, res) => {
    const [row] = await prisma.$queryRawUnsafe<RawMsg[]>(`SELECT * FROM contact_messages WHERE id = ?`, req.params.id);
    if (!row) throw notFound('Message not found.');
    const { status, note } = updateSchema.parse(req.body);
    const newStatus = status ?? row.status;
    const newNote = note !== undefined ? note : row.note;
    await prisma.$executeRawUnsafe(
      `UPDATE contact_messages SET status = ?, note = ?, updatedAt = NOW(3) WHERE id = ?`,
      newStatus, newNote, row.id,
    );
    res.json({ ...mapMsg(row), status: newStatus, note: newNote });
  }),
);

// DELETE /api/admin/contacts/:id
adminContactsRouter.delete(
  '/:id',
  route(async (req, res) => {
    await prisma.$executeRawUnsafe(`DELETE FROM contact_messages WHERE id = ?`, req.params.id);
    res.json({ ok: true });
  }),
);
