import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../shared/database/prisma.js';

export interface RealOwnerFixture {
  id: string;
  email: string;
  password: string;
  cleanup: () => Promise<void>;
}

/** Isolated real-database owner fixture; never changes the store owner's credentials. */
export async function createRealOwnerFixture(label: string): Promise<RealOwnerFixture> {
  const tag = randomBytes(8).toString('hex');
  const password = `TestOwner-${tag}!`;
  const owner = await prisma.owner.create({
    data: {
      email: `test.owner.${label}.${tag}@example.test`,
      name: 'Integration Test Owner',
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  return {
    id: owner.id,
    email: owner.email,
    password,
    cleanup: async () => { await prisma.owner.deleteMany({ where: { id: owner.id } }); },
  };
}
