import { expect, test, type Page } from "@playwright/test";

import { seedId } from "../src/db/seed/ids";

/**
 * P3 — Kemitraan (RL-7): portal pemilik mitra & layar kantor pembina. Data dari seed demo
 * `src/db/seed/demo-p3-partner.ts` (tenant MTR-SKL, akun `mitra1` portal, `pembina1` Pembina wilayah tanpa 2FA).
 */
const PASSWORD = "equa-demo-2026";
const PARTNER_TENANT = seedId("tenant:MTR-SKL");
const UNIQUE = `Pompa booster berbunyi keras saat mengisi tandon (e2e ${Date.now()})`;

async function portalLogin(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/mitra");
  await expect(page).toHaveURL(/\/mitra\/masuk/);
  await page.getByLabel("Nama pengguna").fill("mitra1");
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/mitra$/);
}

async function officeLogin(page: Page, username: "pembina1" | "dispatcher1"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill(username);
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/beranda$/);
}

test.describe("P3 — Kemitraan (Paket Minimum Mitra Fase 1)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("US-P3-10 KP-1 KP-2 KP-4 US-P3-11 KP-1 pemilik mitra masuk portal, melihat laporan outletnya, mengajukan dukungan; web kantor & data tenant lain ditolak", async ({ page }) => {
    await portalLogin(page);
    await expect(page.getByTestId("portal-tenant")).toHaveText("Depot Mitra Sukaluyu");
    await expect(page.getByRole("heading", { level: 1, name: "Beranda Mitra Depot EQUA" })).toBeVisible();
    await expect(page.getByTestId("ringkasan-mitra")).toContainText("Galon terjual");
    await expect(page.getByTestId("neraca-air-mitra")).toContainText("Depot Mitra Sukaluyu");
    await expect(page.getByTestId("hak-baca-equa")).not.toBeEmpty();

    // Penjualan per hari per outlet (fungsi laporan POS yang sama dengan EQUA) + unduhan Excel.
    await page.getByRole("navigation", { name: "Menu portal mitra" }).getByRole("link", { name: "Penjualan", exact: true }).click();
    await expect(page).toHaveURL(/\/mitra\/penjualan/);
    await expect(page.getByTestId("tabel-penjualan-mitra")).toContainText("Depot Mitra Sukaluyu");
    const xlsx = await page.request.get("/api/export/p3.partner_sales?format=xlsx");
    expect(xlsx.status()).toBe(200);

    // Pasokan diterima & neraca air versi mitra; tagihan & pembayaran.
    await page.goto("/mitra/pasokan");
    await expect(page.getByTestId("tabel-pasokan-mitra")).toContainText("Truk EQUA");
    await page.goto("/mitra/tagihan");
    await expect(page.getByTestId("daftar-tagihan-mitra")).toContainText("Lunas");
    await expect(page.getByTestId("daftar-tagihan-mitra")).toContainText("Terbuka");

    // Laporan bulanan terbit (tanggal 5) dapat diunduh PDF.
    await page.goto("/mitra/laporan-bulanan");
    const reports = page.getByTestId("daftar-laporan-bulanan");
    if (await reports.count()) {
      const href = await reports.getByRole("link", { name: "PDF" }).first().getAttribute("href");
      const pdf = await page.request.get(href!);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()["content-type"]).toContain("application/pdf");
    }

    // Permintaan dukungan teknis (US-P3-11 KP-1).
    await page.goto("/mitra/dukungan");
    const form = page.getByTestId("form-dukungan-mitra");
    await form.getByLabel("Jenis").selectOption("equipment");
    await form.getByLabel("Uraian kendala").fill(UNIQUE);
    await form.getByRole("button", { name: "Kirim permintaan" }).click();
    await expect(form.getByRole("status")).toContainText("Permintaan dukungan terkirim");
    await expect(page.getByTestId("daftar-dukungan-mitra")).toContainText(UNIQUE);

    // Isolasi (NFR-30, D-07): akun portal tidak membuka web kantor; lampiran/tenant lain ditolak.
    await page.goto("/kemitraan");
    await expect(page).toHaveURL(/\/masuk\?alasan=bukan-web-kantor/);
    const foreign = await page.request.get(`/mitra/lampiran/${seedId("attachment:agreement:PLG-0034")}`);
    expect([403, 404]).toContain(foreign.status());
  });

  test("US-P3-11 KP-1 US-P3-08 KP-2 KP-5 pembina menanggapi dukungan dalam SLA; pasokan & rincian mitra tampil di kantor; mitra melihat tanggapan", async ({ page }) => {
    await officeLogin(page, "pembina1");
    await page.goto("/kemitraan/dukungan");
    const row = page.getByTestId("tabel-dukungan").getByRole("row").filter({ hasText: UNIQUE });
    await expect(row).toContainText("Diajukan");
    await row.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/kemitraan\/dukungan\/[0-9a-f-]{36}$/);
    const respond = page.getByTestId("form-tanggapi-dukungan");
    await respond.getByLabel("Tanggapan untuk mitra").fill("Teknisi EQUA datang besok pukul 09.00; matikan pompa booster sementara.");
    await respond.getByRole("button", { name: "Kirim tanggapan" }).click();
    // Setelah tersimpan, halaman memuat ulang: status Ditanggapi, waktu tanggap & SLA tercatat, formulir berganti "Tandai selesai".
    await expect(page.getByRole("main")).toContainText("Teknisi EQUA datang besok pukul 09.00");
    await expect(page.getByRole("main")).toContainText("Ditanggapi");
    await expect(page.getByRole("main")).toContainText("Tepat waktu");
    await expect(page.getByTestId("form-selesai-dukungan")).toBeVisible();

    await page.goto("/kemitraan/pasokan");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("body")).toContainText("Depot Mitra Sukaluyu");
    await page.goto(`/kemitraan/mitra/${PARTNER_TENANT}`);
    await expect(page.getByRole("heading", { level: 1, name: "Depot Mitra Sukaluyu" })).toBeVisible();
    await expect(page.locator("body")).toContainText("Hak baca EQUA atas data mitra");

    await portalLogin(page);
    await page.goto("/mitra/dukungan");
    await expect(page.getByTestId("daftar-dukungan-mitra")).toContainText("Tanggapan EQUA: Teknisi EQUA datang besok");
  });
});
