import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/**
 * Layar kantor aplikasi sopir (M3): "dicatat kantor" oleh Admin Keuangan dan konfirmasi kendala oleh Dispatcher.
 * Data demo: `src/db/seed/demo-m3-driver.ts` (truk T2 hari ini; rit P-YY-900205/1 Ditugaskan, kendala "Jalan ditutup").
 */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = { keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA" };

/** Tanggal bisnis WIB `YYYY-MM-DD`. */
function wibToday(): string {
  return new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
}

async function login(page: Page, username: "keuangan1" | "dispatcher1"): Promise<void> {
  const used = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/masuk");
    await page.getByLabel("Nama pengguna").fill(username);
    await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    const secret = TOTP[username];
    if (!secret) {
      await expect(page).toHaveURL(/\/beranda$/);
      return;
    }
    await expect(page).toHaveURL(/\/masuk\/2fa$/);
    let code = await generate({ secret });
    if (used.has(code)) {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
      code = await generate({ secret });
    }
    used.add(code);
    await page.getByLabel("Kode verifikasi").fill(code);
    await page.getByRole("button", { name: "Verifikasi" }).click();
    const ok = await page
      .waitForURL(/\/beranda/, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  }
  throw new Error(`Gagal masuk sebagai ${username}`);
}

test.describe.serial("Aplikasi sopir — layar kantor (M3)", () => {
  const tripNo = `P-${wibToday().slice(2, 4)}-900205/1`;

  test("US-M3-09 KP-5 Admin Keuangan mencatat rit Gagal atas nama sopir (HP rusak) → bertanda dicatat kantor & tampil di laporan", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, "keuangan1");
    await page.goto("/sopir-kantor");
    await expect(page).toHaveURL(/\/sopir-kantor\/dicatat-kantor$/);
    await expect(page.getByRole("heading", { level: 1, name: "Dicatat kantor" })).toBeVisible();

    const trip = page.getByTestId(`office-trip-${tripNo}`);
    await expect(trip).toBeVisible();
    await trip.locator("summary").click();
    const form = page.getByTestId(`office-fail-${tripNo}`);
    // Alasan terlalu singkat ditolak dengan pesan berisi tindakan.
    await form.getByLabel("Alasan dicatat kantor").fill("HP rusak");
    await form.getByLabel("Jam kejadian (WIB)").fill("07:15");
    await form.getByLabel("Alasan gagal").selectOption({ label: "Pelanggan tidak ada" });
    await form.getByLabel("Air termuat").selectOption({ label: "Kembali ke sumber" });
    await form.getByRole("button", { name: "Catat Gagal" }).click();
    await expect(form.getByRole("alert")).toContainText(/Alasan/);

    await form.getByLabel("Alasan dicatat kantor").fill("HP truk T2 jatuh dan mati total; sopir melapor lewat telepon pukul 07.20");
    await form.getByLabel("Jam kejadian (WIB)").fill("07:15");
    await form.getByLabel("Alasan gagal").selectOption({ label: "Pelanggan tidak ada" });
    await form.getByLabel("Air termuat").selectOption({ label: "Kembali ke sumber" });
    await form.getByRole("button", { name: "Catat Gagal" }).click();

    // Rit pindah dari daftar terbuka ke tabel "Rit tercatat" dengan penanda dicatat kantor.
    await expect(page.getByTestId(`office-trip-${tripNo}`)).toHaveCount(0);
    const row = page.getByRole("row").filter({ hasText: tripNo });
    await expect(row).toContainText("Gagal");
    await expect(row).toContainText("Dicatat kantor");

    // Laporan dicatat kantor (KPI-01 "tidak di sumber") + tautan ekspor.
    await page.goto("/sopir-kantor/laporan");
    await expect(page.getByRole("heading", { level: 1, name: "Laporan sopir" })).toBeVisible();
    const report = page.getByTestId("office-entry-report");
    await expect(report).toContainText(tripNo);
    await expect(report).toContainText("Rit gagal");
    await expect(report).toContainText("HP truk T2 jatuh");
    const res = await page.request.get(`/api/export/m3.office_entries?format=xlsx&from=${wibToday()}&to=${wibToday()}`);
    expect(res.status()).toBe(200);
  });

  test("US-M3-06 KP-3 Dispatcher melihat kendala sopir dan mengonfirmasinya dengan catatan", async ({ page }) => {
    await login(page, "dispatcher1");
    await page.goto("/sopir-kantor/kendala");
    await expect(page.getByRole("heading", { level: 1, name: "Kendala sopir" })).toBeVisible();
    const item = page.locator("li", { hasText: "Jalan Raya Cianjur–Sukabumi ditutup" }).first();
    await expect(item).toContainText("Jalan ditutup");
    await item.getByLabel("Catatan konfirmasi").fill("Sudah ditelepon, sopir lewat jalur alternatif Cibeber");
    await item.getByRole("button", { name: "Konfirmasi" }).click();
    const confirmed = page.locator("li", { hasText: "Jalan Raya Cianjur–Sukabumi ditutup" }).filter({ hasText: "dikonfirmasi" });
    await expect(confirmed).toBeVisible();
    await page.reload();
    await expect(page.locator("li", { hasText: "Jalan Raya Cianjur–Sukabumi ditutup" }).first()).toContainText("dikonfirmasi");
  });
});
