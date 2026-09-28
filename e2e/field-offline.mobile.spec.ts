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
    // Data hari ini truk T1 sudah diunduh (pull m3.today) sebelum sinyal hilang.
    await expect(page.getByRole("heading", { level: 2, name: /^Rit hari ini · T1 / })).toBeVisible({ timeout: 30_000 });
    // Service worker PWA aktif & mengendalikan halaman (precache halaman lapangan selesai).
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active && !!navigator.serviceWorker.controller);

    // Mode pesawat: halaman tetap tampil, data tersimpan di ponsel (aksi nyata aplikasi sopir M3: Setor).
    await context.setOffline(true);
    await expect(page.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
    const menu = page.getByRole("navigation", { name: "Menu sopir" });
    await menu.getByRole("button", { name: "Setor" }).click();
    await page.getByTestId("setor").getByRole("button", { name: /^Setor Rp/ }).click();
    await expect(page.getByTestId("setoran-diajukan")).toContainText("tersimpan di ponsel");
    await expect(page.getByText("Tersimpan di ponsel: 1")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Setor" })).toBeVisible();
    // Muat ulang tanpa sinyal: halaman dari service worker, antrean tetap di IndexedDB.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Aplikasi Sopir" })).toBeVisible();
    await expect(page.getByText("Tersimpan di ponsel: 1")).toBeVisible();

    // Sinyal kembali → terkirim otomatis (tanpa muat ulang halaman).
    await context.setOffline(false);
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });
    await menu.getByRole("button", { name: "Setor" }).click();
    await expect(page.getByTestId("setoran-diajukan")).toContainText(/Setoran S-\d{2}-\d{6} diajukan/, { timeout: 30_000 });
    await expect(page.getByTestId("setoran-diajukan")).not.toContainText("tersimpan di ponsel");
  });
});
