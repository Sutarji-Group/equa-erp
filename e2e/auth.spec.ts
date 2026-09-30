import { expect, test } from "@playwright/test";
import { generate } from "otplib";

/** Akun demo seed (src/db/seed/constants.ts). */
const OWNER = { username: "pemilik", password: "equa-demo-2026", totpSecret: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA", name: "H. Ahmad Syarifudin" };

test.describe("Masuk web kantor (US-M10-02 KP-4)", () => {
  test("US-M10-02 KP-4 pemilik masuk dengan kata sandi + TOTP demo lalu tiba di beranda; keluar mencabut sesi", async ({ page }) => {
    await page.goto("/beranda");
    await expect(page).toHaveURL(/\/masuk\?lanjut=%2Fberanda$/);
    await expect(page.getByText("Silakan masuk untuk melanjutkan.")).toBeVisible();

    await page.getByLabel("Nama pengguna").fill(OWNER.username);
    await page.getByLabel("Kata sandi", { exact: true }).fill(OWNER.password);
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(page).toHaveURL(/\/masuk\/2fa$/);

    await page.getByLabel("Kode verifikasi").fill(await generate({ secret: OWNER.totpSecret }));
    await page.getByRole("button", { name: "Verifikasi" }).click();
    // Server menolak pemakaian ulang kode (langkah waktu yang sama) — bila server E2E dipakai ulang dalam 30 detik,
    // tunggu langkah TOTP berikutnya lalu coba sekali lagi.
    const rejected = page.getByText(/Kode verifikasi salah/);
    if (await rejected.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
      await page.getByLabel("Kode verifikasi").fill(await generate({ secret: OWNER.totpSecret }));
      await page.getByRole("button", { name: "Verifikasi" }).click();
    }
    await expect(page).toHaveURL(/\/beranda$/);
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(`Selamat (pagi|siang|sore|malam), ${OWNER.name.replace(".", "\\.")}`) })).toBeVisible();
    await expect(page.getByText("Persetujuan menunggu Anda")).toBeVisible();

    // Halaman inti kantor dapat dibuka pemilik (sesi yang sama).
    const pages: [string, string][] = [
      ["/notifikasi", "Notifikasi"],
      ["/persetujuan", "Persetujuan"],
      ["/pengaturan/parameter", "Parameter"],
      ["/pengaturan/notifikasi", "Pengaturan notifikasi"],
      ["/audit", "Jejak audit"],
      ["/bantuan", "Bantuan"],
    ];
    for (const [href, heading] of pages) {
      await page.goto(href);
      await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    }
    // Riwayat & formulir ubah parameter (hanya pemilik).
    await page.goto("/pengaturan/parameter?kunci=PAR-46");
    await expect(page.getByRole("heading", { level: 3, name: "Riwayat" })).toBeVisible();
    // exact: tombol "Simpan perubahan fitur" (bagian Fitur bertahap, S5-C) juga ada di halaman yang sama.
    await expect(page.getByRole("button", { name: "Simpan perubahan", exact: true })).toBeVisible();
    await expect(page.getByText("Fitur bertahap (feature flag)")).toBeVisible();
    // Jejak audit memuat catatan (mis. aktivasi/penyetelan data awal) dan rantai dapat diverifikasi.
    await page.goto("/audit");
    await page.getByRole("button", { name: "Verifikasi keutuhan" }).click();
    await expect(page.getByText(/Rantai jejak audit utuh/)).toBeVisible();
    await page.goto("/beranda");

    // Keluar → kembali ke /masuk; halaman kantor meminta masuk lagi.
    await page.getByRole("button", { name: `Menu pengguna: ${OWNER.name}` }).click();
    await page.getByRole("menuitem", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/masuk\?alasan=keluar$/);
    await page.goto("/beranda");
    await expect(page).toHaveURL(/\/masuk/);
  });

  test("US-M10-02 KP-4 kata sandi salah ditolak dengan pesan tindakan", async ({ page }) => {
    await page.goto("/masuk");
    await page.getByLabel("Nama pengguna").fill("dispatcher1");
    await page.getByLabel("Kata sandi", { exact: true }).fill("bukan-kata-sandinya");
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(page.getByText("Nama pengguna atau kata sandi salah. Periksa lalu coba lagi.")).toBeVisible();
    await expect(page).toHaveURL(/\/masuk$/);
  });
});
