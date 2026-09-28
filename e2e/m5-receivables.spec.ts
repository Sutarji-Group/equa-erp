import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { seedId } from "../src/db/seed/ids";

/** Akun demo seed (src/db/seed/constants.ts): pemilik & Admin Keuangan wajib 2FA; Dispatcher tanpa 2FA. */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
};
/** Data demo M5 (src/db/seed/demo-m5-receivables.ts). */
const SINAR = seedId("customer:PLG-0024");
const SINAR_OVERDUE_INVOICE = seedId("m5:demo:invoice:sinar-a");
const KERUPUK = seedId("customer:PLG-0026");

/** Masuk web kantor; akun 2FA memakai TOTP demo (kode yang sudah terpakai → tunggu langkah waktu berikutnya). */
async function login(page: Page, username: "pemilik" | "keuangan1" | "dispatcher1"): Promise<void> {
  await page.context().clearCookies();
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
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret }));
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

test.describe("M5 — Piutang & Penagihan", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("US-M5-04 KP-3 US-M5-02 KP-1 US-M5-05 KP-1 US-M5-04 KP-4 Admin Keuangan: tindakan harian, pelunasan kantor tertua dulu, pengingat WA dibuka, ekspor umur piutang bertujuan", async ({ page }) => {
    await login(page, "keuangan1");

    // Daftar tindakan harian: akan Ditahan, sudah Ditahan, perlu diingatkan.
    await page.goto("/piutang");
    await expect(page.getByRole("heading", { level: 1, name: "Ringkasan piutang" })).toBeVisible();
    await expect(page.getByTestId("tindakan-akan-ditahan")).toContainText("PT Sinar Tekstil Cianjur");
    await expect(page.getByTestId("tindakan-ditahan")).toContainText("PT Kerupuk Mekar Sari");
    await expect(page.getByTestId("tindakan-ingatkan")).toContainText("CV Tahu Cibuntu Sejahtera");

    // Pelunasan tunai kantor tanpa alokasi manual → faktur tertua (lewat tempo) lunas; pelanggan tidak lagi "akan Ditahan".
    await page.goto(`/piutang/pelunasan?pelanggan=${SINAR}`);
    const form = page.getByTestId("form-pelunasan");
    await expect(form).toBeVisible();
    await form.getByLabel("Jumlah (Rp)").fill("500000");
    await form.getByLabel("Cara bayar").selectOption("cash");
    await form.getByRole("button", { name: "Simpan pelunasan" }).click();
    await expect(form.getByRole("status")).toContainText("Pelunasan Rp 500.000 tercatat — dialokasikan ke 1 faktur.");

    // Rincian pelunasan (alokasi per faktur) + bukti bayar PDF.
    await page.getByTestId("daftar-pelunasan").getByRole("row").filter({ hasText: "PT Sinar Tekstil Cianjur" }).filter({ hasText: "Rp 500.000" }).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/piutang\/pelunasan\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("alokasi-pelunasan")).toContainText(/F-\d{2}-\d{6}/);
    const receipt = await page.request.get(`${new URL(page.url()).pathname}/bukti`);
    expect(receipt.status()).toBe(200);
    expect(receipt.headers()["content-type"]).toContain("application/pdf");

    await page.goto(`/piutang/faktur/${SINAR_OVERDUE_INVOICE}`);
    await expect(page.getByTestId("sisa-faktur")).toHaveText("Rp 0");
    await expect(page.getByTestId("alokasi-faktur")).toContainText("Rp 500.000");
    const pdf = await page.request.get(`/piutang/faktur/${SINAR_OVERDUE_INVOICE}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");

    // Daftar faktur & faktur bulanan (pelanggan tagihan bulanan demo).
    await page.goto("/piutang/faktur");
    await expect(page.getByTestId("daftar-faktur")).toContainText("PT Kerupuk Mekar Sari");
    await page.goto("/piutang/faktur-bulanan");
    await expect(page.getByTestId("pelanggan-bulanan")).toContainText("Hotel Bukit Indah Cugenang");
    await page.goto("/piutang");
    await expect(page.getByTestId("tindakan-ditahan")).toContainText("PT Kerupuk Mekar Sari");
    await expect(page.locator('[data-testid="tindakan-akan-ditahan"]', { hasText: "PT Sinar Tekstil Cianjur" })).toHaveCount(0);

    // Pengingat H+1: tombol membuka WhatsApp berisi nomor faktur & jumlah; status "Dibuka" tercatat.
    await page.context().route(/^https:\/\/wa\.me\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>WhatsApp</title>" }));
    await page.goto("/piutang/pengingat");
    const row = page.getByTestId("pengingat-PLG-0018-after_due");
    await expect(row).toContainText("Perumahan Griya Cianjur Asri");
    await expect(row).toContainText("H+1 sesudah jatuh tempo");
    await expect(row).toContainText("Dijadwalkan");
    const popup = page.context().waitForEvent("page");
    await row.getByRole("button", { name: "Buka WhatsApp" }).click();
    const wa = await popup;
    expect(wa.url()).toMatch(/^https:\/\/wa\.me\/62813\d+\?text=/);
    const text = decodeURIComponent(new URL(wa.url()).searchParams.get("text") ?? "");
    expect(text).toMatch(/F-\d{2}-\d{6}/);
    expect(text).toContain("150.000");
    await wa.close();
    await expect(row).toContainText("Dibuka");
    await expect(row.getByRole("button", { name: "Buka lagi" })).toBeVisible();

    // Ekspor umur piutang (data pelanggan) wajib bertujuan (BR-39) → berkas Excel.
    await page.goto("/piutang/umur");
    await expect(page.getByTestId("umur-pelanggan")).toContainText("PT Kerupuk Mekar Sari");
    await expect(page.getByTestId("kpi04")).toHaveText(/%$/);
    const exportForm = page.getByTestId("ekspor-umur");
    await exportForm.getByLabel("Tujuan ekspor").fill("Rapat penagihan mingguan");
    const download = page.waitForEvent("download");
    await exportForm.getByRole("button", { name: "Excel" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test("US-M5-07 KP-2 US-M5-03 KP-3 pemilik: tanda tangan total saldo awal piutang, buka Ditahan dengan alasan", async ({ page }) => {
    await login(page, "pemilik");

    await page.goto("/piutang/saldo-awal");
    await expect(page.getByRole("heading", { level: 1, name: "Saldo awal piutang" })).toBeVisible();
    await expect(page.getByTestId("total-saldo-awal")).toContainText("2.000.000");
    await expect(page.getByTestId("saldo-awal-pelanggan")).toContainText("PT Pakan Ternak Sukamaju");
    const sign = page.getByTestId("form-tanda-tangan-saldo-awal");
    await sign.getByLabel("Catatan (opsional)").fill("Sesuai konfirmasi pelanggan (uji E2E)");
    await sign.getByRole("button", { name: /Tanda tangani Rp 2\.000\.000/ }).click();
    // Setelah ditandatangani formulirnya hilang (revalidasi) dan status tanda tangan tampil.
    await expect(page.getByTestId("form-tanda-tangan-saldo-awal")).toHaveCount(0);
    await expect(page.getByText("Ditandatangani", { exact: true }).first()).toBeVisible();

    // Pembukaan Ditahan sebelum lunas: hanya pemilik, dengan alasan (berlaku sampai keterlambatan berikutnya).
    await page.goto("/piutang/status-kredit");
    const held = page.getByTestId("daftar-ditahan").getByRole("row", { name: /PT Kerupuk Mekar Sari/ });
    await held.getByRole("button", { name: "Buka Ditahan" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Alasan").fill("Pelanggan berjanji melunasi Jumat, pesanan pabrik mendesak");
    await dialog.getByRole("button", { name: "Buka Ditahan" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-testid="daftar-ditahan"]', { hasText: "PT Kerupuk Mekar Sari" })).toHaveCount(0);

    await page.goto(`/piutang/pelanggan/${KERUPUK}`);
    await expect(page.getByTestId("riwayat-status-kredit")).toContainText("Pelanggan berjanji melunasi Jumat");
    await expect(page.getByTestId("kartu-piutang")).toContainText(/F-\d{2}-\d{6}/);
  });

  test("US-M5-03 KP-1 US-M5-01 KP-4 Dispatcher: status kredit & eksposur pelanggan; layar keuangan ditolak", async ({ page }) => {
    await login(page, "dispatcher1");

    await page.goto("/piutang/status-kredit");
    await expect(page.getByRole("heading", { level: 1, name: "Status kredit" })).toBeVisible();
    const check = page.getByTestId("cek-eksposur");
    await check.getByLabel("Pelanggan").selectOption(SINAR);
    await check.getByRole("button", { name: "Lihat" }).click();
    await expect(page).toHaveURL(new RegExp(`pelanggan=${SINAR}`));
    const exposure = page.getByTestId("eksposur-pelanggan");
    await expect(exposure).toContainText("Saldo piutang");
    await expect(exposure).toContainText("Sisa batas");

    // Pelunasan & faktur adalah layar keuangan: Dispatcher dialihkan ke beranda (akses ditolak tercatat).
    await page.goto("/piutang/pelunasan");
    await expect(page).toHaveURL(/\/beranda\?ditolak=1$/);
  });
});
