/**
 * Run once to enable pg_trgm and create GIN trigram indexes.
 * Usage: npx tsx api/scripts/setup-trgm.ts
 */
import { prisma } from "../lib/prisma";

async function main() {
  console.log("Enabling pg_trgm extension...");
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  console.log("Creating GIN trigram indexes...");
  await prisma.$executeRawUnsafe(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS pdf_files_original_name_trgm_idx
    ON pdf_files USING GIN (original_name gin_trgm_ops)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS pdf_files_title_trgm_idx
    ON pdf_files USING GIN (title gin_trgm_ops)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS pdf_files_category_trgm_idx
    ON pdf_files USING GIN (category gin_trgm_ops)
  `);

  console.log("Done! ILIKE queries on pdf_files are now fast.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
