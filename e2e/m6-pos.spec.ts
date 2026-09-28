import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { seedId } from "../src/db/seed/ids";

/** Akun demo seed (src/db/seed/constants.ts). */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  admin1: "EQUADEMOADMINSATURAHASIATOTPAAAA",
};
const D02 = seedId("outlet:D02");
const DEMO_SHIFT = seedId("m6:demo:shift:D02:closed");

/** Masuk web kantor (kata sandi + TOTP demo); kode yang sudah terpakai → tunggu langkah waktu berikutnya. */
async function login(page: Page, username: "pemilik" | "admin1"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill(username);
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/masuk\/2fa$/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret: TOTP[username]! }));
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

test.describe("M6 — layar kantor outlet", () => {
  test.describe.configure({ mode: "serial" });

  test("US-M6-07 KP-5 US-M6-02 KP-5 US-M6-03 KP-3 pemilik memantau outlet, membuka rincian shift demo, laporan void & ekspor Excel", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto("/outlet");
    await expect(page.getByRole("heading", { level: 1, name: "Pemantauan outlet" })).toBeVisible();
    await expect(page.getByTestId("tabel-outlet")).toContainText("D02 · Depot EQUA Muka");

    // Rincian outlet → tab Shift → shift demo kemarin.
    await page.getByRole("link", { name: "D02 · Depot EQUA Muka" }).click();
    await expect(page).toHaveURL(new RegExp(`/outlet/${D02}`));
    await page.getByRole("link", { name: "Shift", exact: true }).click();
    await expect(page.getByTestId("tabel-shift")).toContainText("Imas Masitoh");
    await page.goto(`/outlet/shift/${DEMO_SHIFT}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Shift D02");
    const sales = page.getByTestId("tabel-transaksi-shift");
    await expect(sales.locator("tbody tr")).toHaveCount(8);
    await expect(sales).toContainText("Di-void");
    await expect(page.getByText("Kembalian lebih Rp2.000")).toBeVisible();
    await expect(page.getByTestId("daftar-setoran")).toContainText("Setoran akhir shift");
    await expect(page.getByTestId("menunggu-sinkron")).toHaveCount(0);

    // Laporan void per outlet per hari + ekspor Excel/PDF.
    await page.goto("/outlet/laporan?tab=void");
    await expect(page.getByTestId("laporan-void")).toContainText("D02");
    const xlsx = await page.request.get(`/api/export/m6.voids?format=xlsx&outletId=${D02}`);
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");
    const pdf = await page.request.get(`/api/export/m6.outlet_daily?format=pdf`);
    expect(pdf.status()).toBe(200);

    // Pemakaian bahan vs penjualan (rasio per galon) & neraca air.
    await page.goto("/outlet/laporan?tab=pemakaian");
    await expect(page.getByTestId("laporan-pemakaian")).toContainText("Tutup galon");
    await page.goto("/outlet/laporan?tab=air");
    await expect(page.getByTestId("laporan-neraca-air")).toContainText("Depot EQUA Muka");
  });

  test("US-M6-07 KP-3 pemilik mengatur ambang per outlet tanpa kode (PAR-04 berlaku mulai tanggal)", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto(`/outlet/${D02}?tab=pengaturan`);
    const form = page.getByTestId("form-ambang");
    await form.getByLabel("Parameter").selectOption("PAR-04");
    await form.getByLabel("Nilai", { exact: true }).fill("75000");
    await form.getByLabel("Alasan perubahan").fill("Depot ramai, void besar perlu persetujuan");
    await form.getByRole("button", { name: "Simpan" }).click();
    await expect(form.getByRole("status")).toContainText("Ambang outlet ditetapkan");
  });

  test("US-M6-07 KP-1 admin sistem membuat tenant mitra dengan salinan katalog standar EQUA", async ({ page }) => {
    await login(page, "admin1");
    await page.goto("/outlet/tenant");
    await expect(page.getByRole("heading", { level: 1, name: "Tenant & paket POS" })).toBeVisible();
    const form = page.getByTestId("form-tenant");
    await form.getByLabel("Kode tenant").fill("MITRAE2E");
    await form.getByLabel("Nama usaha").fill("Depot Mitra Uji");
    await form.getByLabel("Kode depot").fill("M01");
    await form.getByLabel("Nama depot").fill("Depot Mitra Satu");
    await form.getByLabel("Alasan / nomor kontrak").fill("Kontrak paket POS uji E2E");
    await form.getByRole("button", { name: "Buat tenant mitra" }).click();
    await expect(form.getByRole("status")).toContainText("Katalog standar disalin");
    await expect(page.getByTestId("tabel-tenant")).toContainText("MITRAE2E");
  });
});
