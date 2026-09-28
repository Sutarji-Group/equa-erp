import { expect, test } from "@playwright/test";

/** Kode aktivasi perangkat demo HP-T1 (scripts/e2e-prepare.ts) & PIN demo seed. */
const ACTIVATION_CODE = "UJIE2E26";
const PIN = "123456";

test.describe("Aplikasi lapangan offline (US-M10-02, US-M3-09)", () => {
  test("US-M10-02 KP-1/KP-5 & US-M3-09 KP-2 aktivasi perangkat → login PIN → offline tetap tampil & data antre → online terkirim", async ({
    page,
    context,
  }) => {
    await page.goto("/aktivasi-perangkat");
    await page.getByLabel("Kode aktivasi").fill(ACTIVATION_CODE);
    await page.getByRole("button", { name: "Aktifkan" }).click();
    await expect(page).toHaveURL(/\/sopir$/);

    // Perangkat truk T1: sopir & kernet T1 tersedia.
    await page.getByRole("button", { name: /Asep Saepudin/ }).click();
    for (const digit of PIN) await page.getByRole("button", { name: digit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Aplikasi Sopir" })).toBeVisible();
    await expect(page.getByText("Semua terkirim")).toBeVisible();
    // Service worker PWA aktif & mengendalikan halaman (precache halaman lapangan selesai).
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active && !!navigator.serviceWorker.controller);

    // Mode pesawat: halaman tetap tampil, data tersimpan di ponsel.
    await context.setOffline(true);
    await expect(page.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
    await page.getByRole("button", { name: "Kirim data uji" }).click();
    await expect(page.getByText("Tersimpan di ponsel: 1")).toBeVisible();
    await expect(page.getByText(/^Tersimpan di ponsel · /)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Aplikasi Sopir" })).toBeVisible();
    // Muat ulang tanpa sinyal: halaman dari service worker, antrean tetap di IndexedDB.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Aplikasi Sopir" })).toBeVisible();
    await expect(page.getByText("Tersimpan di ponsel: 1")).toBeVisible();

    // Sinyal kembali → terkirim otomatis (tanpa muat ulang halaman).
    await context.setOffline(false);
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Terkirim · /)).toBeVisible();
  });
});
