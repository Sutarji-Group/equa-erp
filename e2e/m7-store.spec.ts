import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { seedId } from "../src/db/seed/ids";

/** Akun demo seed (src/db/seed/constants.ts). */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
};
const SUBSTITUTE = seedId("m7:demo:receipt:substitute");
const TK1 = seedId("outlet:TK1");

/** Masuk web kantor (kata sandi + TOTP demo); kode yang sudah terpakai → tunggu langkah waktu berikutnya. */
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

test.describe("M7 — layar kantor toko", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("US-M7-02 KP-3 US-M7-08 KP-1/KP-2 Admin Keuangan: stok & HPP toko, terima nota pengganti, umur utang pemasok, bayar pemasok, ekspor", async ({ page }) => {
    await login(page, "keuangan1");

    // Barang & stok: saldo, harga umum/mitra, HPP rata-rata; lampu UV di bawah minimum.
    await page.goto("/toko/barang");
    await expect(page.getByRole("heading", { level: 1, name: "Barang & stok toko" })).toBeVisible();
    const items = page.getByTestId("tabel-barang-toko");
    await expect(items).toContainText("Tutup galon");
    await expect(items).toContainText("Lampu UV 40 watt");
    await page.getByRole("link", { name: "Tisu segel galon" }).click();
    await expect(page.getByTestId("kartu-stok")).toContainText("Penyesuaian opname");
    await expect(page.getByTestId("riwayat-harga")).toContainText("Harga mitra");

    // Nota pengganti dari seed → diterima Admin Keuangan (bukan penerima barang) → stok & utang tercatat.
    await page.goto(`/toko/pembelian/${SUBSTITUTE}`);
    await expect(page.getByText("Nota pengganti").first()).toBeVisible();
    const accept = page.getByTestId("form-terima-pengganti");
    await accept.getByLabel("Nomor nota susulan (bila ada)").fill("FJ-2201");
    await accept.getByRole("button", { name: "Terima sebagai nota" }).click();
    // Formulir hilang setelah diterima; ringkasan mencatat waktu penerimaan & nomor nota susulan.
    await expect(page.getByTestId("form-terima-pengganti")).toHaveCount(0);
    await expect(page.getByText("Nota pengganti diterima", { exact: true })).toBeVisible();
    await expect(page.getByText("FJ-2201").first()).toBeVisible();

    // Utang per pemasok & umur → bayar CV Sumber Plastik (kas kantor, alokasi otomatis ke nota tertua).
    await page.goto("/toko/utang");
    const aging = page.getByTestId("umur-utang");
    await expect(aging).toContainText("CV Sumber Plastik Cianjur");
    await expect(aging).toContainText("UD Filter Jaya Bandung");
    await aging.getByRole("link", { name: "CV Sumber Plastik Cianjur" }).click();
    await expect(page).toHaveURL(/pemasok=/);
    const pay = page.getByTestId("form-bayar-pemasok");
    await pay.getByLabel("Jumlah bayar (Rp)").fill("500000");
    await pay.getByLabel("Cara bayar").selectOption("cash");
    await pay.getByRole("button", { name: "Simpan pembayaran" }).click();
    await expect(pay.getByRole("status")).toContainText("Pembayaran tercatat");
    await page.reload();
    await expect(page.getByTestId("riwayat-bayar")).toContainText("CV Sumber Plastik Cianjur");
    await expect(page.getByTestId("umur-utang")).not.toContainText("CV Sumber Plastik Cianjur");

    const xlsx = await page.request.get("/api/export/m7.payables_aging?format=xlsx");
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");

    // Opname: riwayat bulan lalu (selisih tisu beralasan) tersedia.
    await page.goto("/toko/opname");
    await expect(page.getByTestId("tabel-opname")).toContainText("Opname bulanan toko");
    await page.getByTestId("tabel-opname").getByRole("link").first().click();
    await expect(page.getByTestId("lembar-opname")).toContainText("Rusak");

    // Pemasok, daftar nota, pesan ulang.
    await page.goto("/toko/pemasok");
    await expect(page.getByTestId("tabel-pemasok")).toContainText("Toko Grosir Makmur");
    await page.goto("/toko/pembelian");
    await expect(page.getByTestId("tabel-nota")).toContainText("SP-118");
    await page.goto("/toko/pesan-ulang");
    // Filter keluar dari daftar setelah nota pengganti diterima (barang masuk); lampu UV tetap.
    await expect(page.getByTestId("tabel-pesan-ulang")).toContainText("Lampu UV 40 watt");
    await expect(page.getByTestId("tabel-pesan-ulang")).not.toContainText("Filter cartridge 10 inci");

    // US-M7-01 KP-5: retur pelanggan setelah shift ditutup (≤ PAR-21 → langsung; stok kembali).
    await page.goto("/toko/laporan?tab=retur");
    const sale = page.getByTestId("transaksi-retur").locator("li", { hasText: "Sabun cuci galon" }).first();
    await sale.getByText("Catat retur").click();
    await sale.getByLabel(/Sabun cuci galon 1 L \(maks\. 1\)/).fill("1");
    await sale.getByLabel("Alasan").fill("Segel botol bocor, dikembalikan pelanggan");
    await sale.getByRole("button", { name: "Simpan retur" }).click();
    await expect(page.getByTestId("transaksi-retur").locator("li", { hasText: "Sabun cuci galon" }).first()).toContainText("diretur 1");
  });

  test("US-M7-07 KP-1/KP-2/KP-3 US-M7-06 KP-3 pemilik: barang laris/mati & margin, pembelian mitra, transfer internal per depot, ekspor PDF", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto("/toko/laporan");
    await expect(page.getByRole("heading", { level: 1, name: "Laporan toko" })).toBeVisible();
    // Data demo = kemarin; pilih bulan transaksi demo bila berbeda dengan bulan berjalan.
    const yesterday = new Date(Date.now() - 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 7);
    await page.goto(`/toko/laporan?tab=performa&bulan=${yesterday}&toko=${TK1}`);
    const perf = page.getByTestId("laporan-performa");
    await expect(perf).toContainText("Lampu UV 40 watt");
    await expect(perf).toContainText("Laris");
    await page.getByRole("link", { name: "Pembelian mitra" }).click();
    await expect(page.getByTestId("laporan-mitra")).toContainText("Depot Barokah Cilaku");
    await page.getByRole("link", { name: "Diskon" }).click();
    await expect(page.getByTestId("laporan-diskon")).toContainText("Pelanggan tetap");
    await page.getByRole("link", { name: "Transfer internal" }).click();
    await expect(page.getByText(/Per depot —/)).toBeVisible();
    const pdf = await page.request.get(`/api/export/m7.product_performance?format=pdf&month=${yesterday}&outletId=${TK1}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
  });
});
