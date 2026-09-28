/**
 * `pnpm db:migrate` — terapkan migrasi SQL `drizzle/` (hasil `pnpm db:generate`) ke DB terkonfigurasi (produksi Neon:
 * DB_DRIVER=neon + DATABASE_URL), lalu trigger pengerasan (`src/db/sql/hardening.sql`, idempoten).
 */
import { closeDb, getDb, getDbDriver } from "@/db/client";
import { applyDbHardening } from "@/db/hardening";

const MIGRATIONS_FOLDER = "./drizzle";

async function main(): Promise<void> {
  const db = getDb();
  const driver = getDbDriver();
  console.log(`db:migrate → driver ${driver}, folder ${MIGRATIONS_FOLDER}`);
  switch (driver) {
    case "pglite": {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_FOLDER });
      break;
    }
    case "neon": {
      const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_FOLDER });
      break;
    }
    case "pg": {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS_FOLDER });
      break;
    }
    default:
      throw new Error(`Driver ${driver} tidak didukung untuk migrasi.`);
  }
  await applyDbHardening(db);
  console.log("Migrasi & trigger pengerasan diterapkan.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
