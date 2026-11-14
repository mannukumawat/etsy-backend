import { prisma } from '../../shared/database/prisma.js';
import { notFound } from '../../shared/errors/http-error.js';
import { sendMail } from '../../shared/mail/mailer.js';
import { randomHexId } from '../../shared/utils/ids.js';
import { toAdminContactMessage, type RawContactMessage } from './contact.mapper.js';
import type { ContactInput, ContactUpdateInput } from './contact.schema.js';

const PAGE_SIZE = 25;

export async function submitContactMessage({ name, email, subject, orderNumber, message }: ContactInput): Promise<{ reference: string }> {
  const id = randomHexId(10);
  const reference = `MSG-${id.toUpperCase().slice(0, 8)}`;

  await prisma.$executeRawUnsafe(
    `INSERT INTO contact_messages (id, name, email, subject, orderNumber, message, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 'unread', NOW(3), NOW(3))`,
    reference, name, email, subject, orderNumber ?? '', message,
  );

  // Notify store owner via email (best-effort — no SMTP = no email but request still succeeds)
  const store = await prisma.storeSettings.findFirst({ select: { contactEmail: true, nameEn: true } });
  if (store?.contactEmail) {
    await sendMail(
      store.contactEmail,
      `New contact message [${reference}] — ${subject}`,
      `Reference: ${reference}\nFrom: ${name} <${email}>\nSubject: ${subject}${orderNumber ? `\nOrder: ${orderNumber}` : ''}\n\n${message}`,
    );
  }

  return { reference };
}

export async function listContactMessages({ status, page }: { status: string | null; page: number }) {
  const offset = (page - 1) * PAGE_SIZE;

  const whereClause = status ? `WHERE status = ?` : '';
  const params: unknown[] = status ? [status, PAGE_SIZE, offset] : [PAGE_SIZE, offset];

  const rows = await prisma.$queryRawUnsafe<RawContactMessage[]>(
    `SELECT * FROM contact_messages ${whereClause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    ...params,
  );
  const [{ total }] = await prisma.$queryRawUnsafe<[{ total: bigint }]>(
    `SELECT COUNT(*) as total FROM contact_messages ${whereClause}`,
    ...(status ? [status] : []),
  );

  return { items: rows.map(toAdminContactMessage), total: Number(total), page, pages: Math.ceil(Number(total) / PAGE_SIZE) };
}

export async function findContactMessageOrThrow(id: string): Promise<RawContactMessage> {
  const [row] = await prisma.$queryRawUnsafe<RawContactMessage[]>(`SELECT * FROM contact_messages WHERE id = ?`, id);
  if (!row) throw notFound('Message not found.');
  return row;
}

/** Reading a message in the admin marks it as read. */
export async function openContactMessage(id: string) {
  const row = await findContactMessageOrThrow(id);
  if (row.status === 'unread') {
    await prisma.$executeRawUnsafe(`UPDATE contact_messages SET status = 'read', updatedAt = NOW(3) WHERE id = ?`, row.id);
    row.status = 'read';
  }
  return toAdminContactMessage(row);
}

export async function updateContactMessage(row: RawContactMessage, { status, note }: ContactUpdateInput) {
  const newStatus = status ?? row.status;
  const newNote = note !== undefined ? note : row.note;
  await prisma.$executeRawUnsafe(
    `UPDATE contact_messages SET status = ?, note = ?, updatedAt = NOW(3) WHERE id = ?`,
    newStatus, newNote, row.id,
  );
  return { ...toAdminContactMessage(row), status: newStatus, note: newNote };
}

export async function deleteContactMessage(id: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM contact_messages WHERE id = ?`, id);
}
