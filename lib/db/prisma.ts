import { PrismaClient } from "@prisma/client";

/**
 * Prisma singleton. In dev, Next.js hot-reload would otherwise open a new pool
 * on every reload and exhaust Postgres connections.
 *
 * `DATABASE_URL` is optional during Phase 1: without it, services fall back to
 * the curated asset file + direct provider calls (see lib/market-data/service).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const isDatabaseConfigured = Boolean(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
