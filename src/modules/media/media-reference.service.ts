import { prisma } from '../../shared/database/prisma.js';
import { badRequest } from '../../shared/errors/http-error.js';

export async function assertMediaExists(ids: Array<string | null>) {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (!wanted.length) return;
  const found = await prisma.media.findMany({ where: { id: { in: wanted } }, select: { id: true } });
  const missing = wanted.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw badRequest(`Unknown image reference: ${missing.join(', ')}.`, [{ path: 'images', message: 'Image no longer exists.' }]);
}
