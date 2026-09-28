import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { seedId } from "../src/db/seed/ids";

/**
 * Aplikasi Operator Produksi (M8) di ponsel sumber air SA1 (seed `HP-SA1`, operator produksi1 "Maman Suherman"), di
 * atas data demo `src/db/seed/demo-m8-production.ts` (angka meter malam kemarin 12.503.900 L; truk T3 terjadwal
 * mengisi di SA1 hari ini). Alur: admin sistem menerbitkan kode aktivasi → aktivasi → PIN → catat meter pagi (3 langkah
 * + foto) → isi truk T3 TANPA SINYAL → tersimpan di ponsel → sinyal kembali → terkirim → riwayat & bantuan.
 */
const PASSWORD = "equa-demo-2026";
const ADMIN_TOTP = "EQUADEMOADMINSATURAHASIATOTPAAAA";
const PIN = "123456";
const DEVICE_ID = seedId("device:HP-SA1");
const OPERATOR = "Maman Suherman";
/** PNG 1×1 sah (foto uji; dikompres ulang di ponsel menjadi JPEG). */
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function loginAdmin(page: Page): Promise<void> {
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill("admin1");
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/masuk\/2fa$/);
  // Kode TOTP yang baru dipakai spesifikasi lain ditolak (anti-replay) → tunggu langkah waktu berikutnya.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret: ADMIN_TOTP }));
    await page.getByRole("button", { name: "Verifikasi" }).click();
    const ok = await page
      .waitForURL(/\/beranda/, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  }
  throw new Error("Gagal masuk sebagai admin1");
}

/** Ukuran huruf terhitung (px) elemen pertama yang cocok. */
async function fontPx(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
}

test.describe("M8 — aplikasi operator produksi di ponsel (offline-first)", () => {
  test.setTimeout(240_000);

  test("US-M8-01 KP-1 US-M8-02 KP-1 KP-2 US-M8-07 KP-1 KP-2 KP-3 operator: aktivasi → PIN → meter pagi + foto (3 langkah) → isi truk tanpa sinyal → terkirim → riwayat & bantuan", async ({ page, context }) => {
    // Admin sistem menerbitkan kode aktivasi ponsel sumber air SA1 (M10).
    await loginAdmin(page);
    await page.goto(`/akses/perangkat/${DEVICE_ID}`);
    await page.getByText("Terbitkan kode aktivasi baru").click();
    await page.getByLabel("Alasan").last().fill("Ponsel sumber dipasang ulang (uji E2E)");
    await page.getByRole("button", { name: "Terbitkan kode" }).click();
    const code = (await page.getByTestId("kode-sekali").textContent())!.trim();
    expect(code.length).toBeGreaterThanOrEqual(6);
    await context.clearCookies();

    // Aktivasi → aplikasi produksi → operator + PIN (data referensi hari ini diunduh saat login).
    await page.goto("/aktivasi-perangkat");
    await page.getByLabel("Kode aktivasi").fill(code);
    await page.getByRole("button", { name: "Aktifkan" }).click();
    await expect(page).toHaveURL(/\/produksi$/);
    await page.getByRole("button", { name: new RegExp(OPERATOR) }).click();
    for (const digit of PIN) await page.getByRole("button", { name: digit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Produksi Air" })).toBeVisible();
    const meterCard = page.getByTestId("kartu-meter");
    await expect(meterCard).toBeVisible({ timeout: 30_000 });
    await expect(meterCard).toContainText("MTR-SA1-01");

    // US-M8-07 KP-3: teks ≥ 16 pt setara (tema lapangan 18 px) & tombol besar.
    expect(await fontPx(page, "[data-testid='kartu-meter'] h2")).toBeGreaterThanOrEqual(16);
    expect(await fontPx(page, "[data-testid='kartu-meter'] button")).toBeGreaterThanOrEqual(16);

    // US-M8-01 KP-1: meter pagi = 3 langkah (meter & fase → angka → foto & simpan).
    await meterCard.getByRole("button", { name: "Catat meter" }).click();
    await expect(page.getByText("Langkah 1 dari 3")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Pagi \(awal\)/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByText("Langkah 2 dari 3")).toBeVisible();
    await expect(page.getByTestId("langkah-angka")).toContainText("12.503.900");
    // US-M8-01 KP-2: angka lebih kecil dari pembacaan sebelumnya ditolak dengan pesan tindakan.
    await page.getByLabel("Angka pada meter").fill("12500000");
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "lebih kecil dari pembacaan sebelumnya" })).toBeVisible();
    await page.getByLabel("Angka pada meter").fill("12505200");
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByText("Langkah 3 dari 3")).toBeVisible();
    await page.getByRole("button", { name: "Simpan angka meter" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Ambil foto meter" })).toBeVisible();
    await page.getByLabel("Foto meter", { exact: true }).setInputFiles({ name: "meter.png", mimeType: "image/png", buffer: PHOTO });
    await expect(page.getByText(/Foto tersimpan/).first()).toBeVisible();
    // Setelah 08.00 WIB pembacaan pagi tercatat terlambat → alasan wajib (US-M8-01 KP-3).
    const late = page.getByLabel("Alasan terlambat");
    if (await late.isVisible()) await late.fill("Uji E2E di luar jam pembacaan pagi");
    await page.getByRole("button", { name: "Simpan angka meter" }).click();
    await expect(page.getByTestId("meter-tersimpan")).toContainText("12.505.200 L");
    await page.getByRole("button", { name: "Kembali ke Hari ini" }).click();
    await expect(page.getByTestId("meter-MTR-SA1-01-morning")).toContainText("12.505.200 L");
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // US-M8-07 KP-1/KP-2: tanpa sinyal pengisian truk tetap tercatat di ponsel (status per data), lalu terkirim otomatis.
    await context.setOffline(true);
    await expect(page.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
    await page.getByRole("navigation", { name: "Menu produksi" }).getByRole("button", { name: "Isi truk" }).click();
    // US-M8-02 KP-1: truk yang dijadwalkan mengisi di SA1 tampil pertama; rit berikutnya disarankan; volume bawaan.
    const t3 = page.getByTestId("truk-T3");
    await expect(t3).toBeVisible();
    await expect(t3).toContainText("Rit berikutnya");
    await t3.click();
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByLabel("Volume diisi")).toHaveValue("5.000");
    await expect(page.getByRole("radiogroup", { name: "Rit tujuan" }).getByRole("radio", { checked: true })).toContainText("(disarankan)");
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByTestId("langkah-simpan-isi")).toContainText("5.000 L");
    await page.getByRole("button", { name: "Simpan pengisian" }).click();
    await expect(page.getByTestId("isi-tersimpan")).toContainText("tersimpan di ponsel");
    await expect(page.getByText(/Tersimpan di ponsel: \d+/).first()).toBeVisible();
    await page.getByRole("button", { name: "Kembali ke Hari ini" }).click();
    await expect(page.getByTestId("total-isi")).toContainText("5.000 L");

    await context.setOffline(false);
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 45_000 });

    // Riwayat: status per data "Terkirim"; Bantuan: laporan kendala aplikasi + antrean data (B-03).
    await page.getByRole("navigation", { name: "Menu produksi" }).getByRole("button", { name: "Riwayat" }).click();
    const row = page.getByTestId("baris-isi").filter({ hasText: "T3" }).first();
    await expect(row).toContainText("5.000 L");
    await expect(row).toContainText("Terkirim", { timeout: 30_000 });
    await page.getByRole("navigation", { name: "Menu produksi" }).getByRole("button", { name: "Bantuan" }).click();
    await expect(page.getByText("Laporkan kendala aplikasi", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("list", { name: "Data terakhir" })).toContainText("Isi truk T3");
  });
});
