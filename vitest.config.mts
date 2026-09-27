import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Catatan: alias '@/*' diselesaikan resolver tsconfig bawaan Vite 8 (`resolve.tsconfigPaths`), pengganti plugin
// vite-tsconfig-paths (paket tetap terpasang bila perlu kembali: `plugins: [tsconfigPaths()]`).
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // 'server-only' melempar galat di luar kondisi react-server; di uji cukup modul kosong.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    // Bawaan node. Uji komponen: tambahkan komentar `// @vitest-environment happy-dom` di baris pertama berkas.
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Mesin berbagi CPU dengan agen lain; PGlite in-memory per berkas cukup berat.
    maxWorkers: "50%",
    env: {
      TZ: "UTC",
      DB_DRIVER: "pglite",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/components/ui/**", "src/app/**"],
    },
  },
});
