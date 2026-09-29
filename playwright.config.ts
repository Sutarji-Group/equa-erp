import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// Browser Chromium sudah terpasang di mesin pengembangan (build 1194 = @playwright/test 1.56.x).
// Jangan jalankan `playwright install` di sini; di CI biarkan Playwright memakai browsernya sendiri.
const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // Web kantor & portal (desktop).
      name: "chromium",
      testIgnore: [/\.mobile\.spec\.ts$/, /scenarios\//],
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
    {
      // PWA lapangan (sopir, produksi, POS): beri nama berkas `*.mobile.spec.ts`.
      name: "mobile",
      testMatch: /\.mobile\.spec\.ts$/,
      use: {
        ...devices["Pixel 7"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
    {
      // Skenario lintas modul BRD Bab 5 P-01..P-07 (docs/qa/skenario-uji.md): satu hari operasi di atas data yang sama,
      // web kantor (desktop) + aplikasi lapangan/POS (konteks ponsel/tablet dibuat di dalam uji). Didaftarkan TERAKHIR
      // agar berjalan setelah spesifikasi modul (workers = 1) dan menutup kas/buku atas seluruh transaksi hari itu.
      name: "scenarios",
      testMatch: /scenarios\/.*\.spec\.ts$/,
      timeout: 15 * 60_000,
      use: {
        ...devices["Desktop Chrome"],
        actionTimeout: 20_000,
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // DB E2E disiapkan ulang (skema + seed + kode aktivasi perangkat demo), lalu build produksi & start;
        // set E2E_DEV=1 untuk memakai `pnpm dev` (lebih cepat saat iterasi).
        command: process.env.E2E_DEV
          ? `pnpm e2e:prepare && pnpm dev --port ${PORT}`
          : `pnpm e2e:prepare && pnpm build && pnpm start --port ${PORT}`,
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        env: {
          // `next start` = NODE_ENV production → rahasia bawaan dev & TOTP seed `plain:` hanya dengan izin eksplisit.
          ALLOW_DEV_SECRETS: "1",
          // Jam tersuntik KHUSUS E2E (cookie `equa_e2e_clock`, `/api/cron/tick?now=`) — skenario P-01/P-05/P-07
          // (src/server/core/e2e-clock.ts). Tidak berlaku tanpa ALLOW_DEV_SECRETS & tidak pernah di deploy Vercel.
          E2E_CLOCK_OVERRIDE: "1",
          DB_DRIVER: process.env.DB_DRIVER ?? "pglite",
          PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR ?? "./.data/pglite-e2e",
        },
      },
});
