import { Prisma } from '../generated/prisma/client';

/** Unique-constraint violation from a Prisma model call (P2002) or a raw query (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  return error.code === 'P2010' && JSON.stringify(error.meta ?? {}).includes('23505');
}

export type Tx = Prisma.TransactionClient;
