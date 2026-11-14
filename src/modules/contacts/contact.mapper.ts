export type RawContactMessage = {
  id: string; name: string; email: string; subject: string;
  orderNumber: string; message: string; status: string;
  note: string | null; createdAt: Date; updatedAt: Date;
};

export function toAdminContactMessage(r: RawContactMessage) {
  return { id: r.id, name: r.name, email: r.email, subject: r.subject, orderNumber: r.orderNumber || null, message: r.message, status: r.status, note: r.note ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt };
}
