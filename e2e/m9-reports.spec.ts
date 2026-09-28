import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/**
 * M9 — Laporan & Dashboard (web kantor) di atas data demo M2–M8/M12 + `src/db/seed/demo-m9-reports.ts`
 * (KPI-10 dua bulan; periode paralel T1 ditarik hari ke-14, D10 berjalan hari ke-7 dengan syarat PAR-84 terpenuhi).
 * Alur 1: pemilik membuka beranda → H+0 (enam blok, rentang, turun ke rincian) → laporan bulanan + unduh Excel →
 * katalog → KPI (isi KPI-10). Alur 2: Admin Keuangan mengajukan tarik nota kertas D10 lebih awal → pemilik menyetujui
 * dari kotak masuk → unit tercatat "Nota kertas ditarik".
 */

const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
};

async function login(page: Page, username: "pemilik" | "keuangan1"): Promise<void> {
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

test.describe("M9 — Laporan & Dashboard pemilik", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test("US-M9-01 KP-1 KP-2 KP-3 KP-7 US-M9-02 KP-2 US-M9-03 KP-1 US-M9-07 KP-1 KP-2 pemilik: beranda → H+0 enam blok, rentang & rincian → laporan bulanan + unduh Excel → katalog → KPI-10", async ({ page }) => {
    await login(page, "pemilik");
    await expect(page.getByTestId("beranda-h0")).toBeVisible();

    await page.getByTestId("beranda-h0").getByRole("link", { name: /Buka H\+0/ }).click();
    await expect(page).toHaveURL(/\/laporan\/hari-ini$/);
    await expect(page.getByRole("heading", { name: "Hari ini (H+0)" })).toBeVisible();
    for (const id of ["h0-status", "h0-revenue", "h0-cash", "h0-receivables", "h0-trips", "h0-gallons", "h0-exceptions"]) await expect(page.getByTestId(id)).toBeVisible();
    // Hari ini belum ditutup → angka berjalan berlabel (KP-2).
    await expect(page.getByTestId("h0-status")).toContainText("Belum ditutup — angka dapat berubah");
    await expect(page.getByTestId("h0-internal")).toContainText("Transfer internal");

    // Rentang kemarin (demo rit kemarin) → turun ke rit per truk tanpa pindah modul (KP-3, KP-7).
    await page.getByRole("link", { name: "Kemarin", exact: true }).click();
    await expect(page).toHaveURL(/rentang=yesterday/);
    const truckLink = page.getByTestId("h0-trips").getByRole("link").first();
    if (await truckLink.count()) {
      await truckLink.click();
      await expect(page).toHaveURL(/rinci=truk/);
      await expect(page.getByTestId("h0-drilldown")).toBeVisible();
      await expect(page.getByTestId("h0-drilldown").getByRole("row").nth(1)).toBeVisible();
    }
    await page.getByRole("link", { name: "7 hari", exact: true }).click();
    await expect(page.getByTestId("h0-status")).toBeVisible();

    // Laporan bulanan: status Sementara/Final + unduh Excel (tercatat di log ekspor).
    await page.goto("/laporan/bulanan");
    await expect(page.getByTestId("monthly-status")).toBeVisible();
    await expect(page.getByTestId("monthly-lines")).toContainText("Konsolidasi");
    await expect(page.getByTestId("monthly-water-cost")).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Unduh Excel" }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

    // Katalog 7.9.4.
    await page.goto("/laporan/katalog");
    await expect(page.getByTestId("catalog-h0")).toBeVisible();
    await expect(page.getByTestId("catalog-gross_profit")).toContainText("Laba kotor bulanan per lini");
    await expect(page.getByTestId("catalog-report-m9.kpi")).toBeVisible();

    // KPI program: sebelas KPI + isi KPI-10.
    await page.goto("/laporan/kpi");
    await expect(page.getByTestId("kpi-current").locator("tbody tr")).toHaveCount(11);
    const form = page.getByTestId("kpi10-form");
    await form.getByLabel(/Jam per minggu/).fill("6,5");
    await form.getByRole("button", { name: "Simpan jam" }).click();
    await expect(form.getByRole("status")).toContainText("Jam pemilik (KPI-10) tersimpan.");
    await expect(page.getByTestId("kpi-current").locator('tr[data-kpi="KPI-10"]')).toContainText("6,5 jam/minggu");
  });

  test("US-M9-07 KP-2 US-M9-04 KP-2 periode paralel: Admin Keuangan mengajukan tarik nota kertas D10 lebih awal (PAR-84) → pemilik menyetujui dari kotak masuk", async ({ page }) => {
    await login(page, "keuangan1");
    await page.goto("/laporan/periode-paralel");
    const d10 = page.getByTestId("parallel-units").getByRole("row").filter({ hasText: "D10" });
    await expect(d10).toContainText("Paralel berjalan");
    await expect(d10).toContainText("Terpenuhi");
    const actions = page.getByTestId("parallel-unit-actions").filter({ hasText: "D10" });
    await actions.locator("summary").click();
    await actions.getByRole("button", { name: "Ajukan tarik lebih awal" }).click();
    await expect(actions.getByRole("status").first()).toContainText("diajukan ke pemilik");
    await expect(page.getByTestId("parallel-units").getByRole("row").filter({ hasText: "D10" })).toContainText("Menunggu persetujuan tarik lebih awal");

    await login(page, "pemilik");
    await page.goto("/kotak-masuk");
    const item = page.getByTestId("inbox-group-approval").getByTestId("inbox-item").filter({ hasText: "Tarik nota kertas lebih awal" });
    await expect(item).toHaveCount(1);
    await item.getByRole("button", { name: "Setujui" }).click();
    await expect(page.getByText("Permintaan disetujui.")).toBeVisible();
    await page.goto("/laporan/periode-paralel");
    await expect(page.getByTestId("parallel-units").getByRole("row").filter({ hasText: "D10" })).toContainText("Nota kertas ditarik");
  });
});
