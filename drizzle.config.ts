import { defineConfig } from "drizzle-kit";

const driver = process.env.DB_DRIVER ?? "pglite";

export default driver === "pglite"
  ? defineConfig({
      schema: "./src/db/schema/index.ts",
      out: "./drizzle",
      dialect: "postgresql",
      driver: "pglite",
      dbCredentials: { url: process.env.PGLITE_DATA_DIR ?? "./.data/pglite" },
    })
  : defineConfig({
      schema: "./src/db/schema/index.ts",
      out: "./drizzle",
      dialect: "postgresql",
      dbCredentials: { url: process.env.DATABASE_URL ?? "" },
    });
