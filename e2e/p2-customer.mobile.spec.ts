import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/**
 * P2 — Aplikasi Pelanggan (PWA di ponsel pelanggan). Flag `phase2.customer_app` bawaan mati (D-02): bila layar masih
 * "belum aktif", pemilik mengaktifkannya dulu. E2E memakai `ALLOW_DEV_SECRETS=1` → kode OTP tampil di layar (tanpa
 * WhatsApp Business API) dan gerbang pembayaran tiruan aktif.
 */
const PASSWORD = "equa-demo-2026";
const TOTP_PEMILIK = "EQUADEMOPEMILIKRAHASIATOTPDEVAAA";
/** Nomor WA pelanggan demo PLG-0019 (src/db/seed/customers.ts) — akun aplikasi tertaut (demo-p2-customer.ts). */
const PLG_0019_PHONE = "081310000019";

test.use({ geolocation: { latitude: -6.8244, longitude: 107.1255 }, permissions: ["geolocation"] });

async function ensureAppEnabled(page: Page): Promise<void> {
  await page.goto("/app/masuk");
  const disabled = page.getByRole("heading", { name: "Aplikasi pelanggan EQUA belum aktif" });
  const loginField = page.getByLabel("Nomor WhatsApp");
  await expect(disabled.or(loginField)).toBeVisible();
  if (!(await disabled.isVisible())) return;

  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill("pemilik");
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/masuk\/2fa$/);
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret: TOTP_PEMILIK }));
    await page.getByRole("button", { name: "Verifikasi" }).click();
    ok = await page
      .waitForURL(/\/beranda/, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  }
  if (!ok) throw new Error("Gagal masuk sebagai pemilik");
  await page.goto("/keluhan/akun");
  const toggle = page.getByTestId("toggle-app");
  const enable = toggle.getByRole("button", { name: "Aktifkan aplikasi pelanggan" });
  if (await enable.isVisible()) {
    await toggle.locator('input[name="reason"]').fill("Prasyarat TG-9 terpenuhi (uji E2E ponsel)");
    await enable.click();
    await expect(toggle.getByRole("button", { name: "Nonaktifkan aplikasi" })).toBeVisible();
  }
  await page.context().clearCookies();
}

/** Masuk aplikasi pelanggan: nomor WA → kode OTP (mode uji menampilkan kode di layar) → Masuk. */
async function customerLogin(page: Page, phone: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app/masuk");
  await page.getByLabel("Nomor WhatsApp").fill(phone);
  await page.getByRole("button", { name: "Kirim kode lewat WhatsApp" }).click();
  const dev = page.getByTestId("otp-dev-code");
  await expect(dev).toBeVisible();
  const code = ((await dev.locator("strong").textContent()) ?? "").trim();
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel("Kode verifikasi (6 angka)").fill(code);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
}

/** Pesan ≤ 4 langkah: alamat pertama → 1 tangki → slot pertama yang tersedia → ringkasan. */
async function orderSteps(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Pesan air" }).first().click();
  await expect(page).toHaveURL(/\/app\/pesan$/);
  await page.getByTestId("order-addresses").getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Berapa tangki?" })).toBeVisible();
  await page.getByRole("link", { name: "1", exact: true }).click();
  const slot = page.getByTestId("order-slots").locator('a[data-testid^="slot-"]').first();
  await expect(slot).toBeVisible();
  await slot.click();
  await expect(page.getByTestId("order-summary")).toBeVisible();
  await expect(page.getByTestId("order-total")).toContainText(/Total Rp\s?[\d.]+/);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

test.describe("P2 — Aplikasi Pelanggan (ponsel)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("US-P2-01 KP-1 US-P2-01 KP-3 US-P2-01 KP-5 US-P2-02 KP-1 US-P2-02 KP-5 pelanggan baru daftar dengan OTP WhatsApp + titik peta, memesan ≤ 4 langkah, lalu membatalkan sendiri", async ({ page }) => {
    await ensureAppEnabled(page);
    const phone = `0815${String(Date.now()).slice(-8)}`;
    await customerLogin(page, phone);

    // Nomor baru → lengkapi pendaftaran: nama, titik peta (lokasi perangkat), alamat, persetujuan UU PDP.
    await expect(page).toHaveURL(/\/app\/daftar$/);
    await expect(page.getByTestId("pdp-consent-text")).toContainText("UU PDP");
    await page.getByLabel("Nama sesuai data pelanggan").fill("Ibu Uji Aplikasi");
    await page.getByRole("button", { name: "Pakai lokasi saya" }).click();
    await expect(page.getByText(/-6[.,]82/).first()).toBeVisible();
    await page.getByLabel("Alamat lengkap").fill("Kp. Nagrak RT 04/01, Desa Nagrak, Cianjur");
    await page.getByLabel("Catatan akses (opsional)").fill("Pagar biru, tandon di belakang rumah");
    await page.getByLabel("Saya menyetujui penggunaan data pribadi di atas.").check();
    await page.getByRole("button", { name: "Simpan & mulai pesan" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText("Halo, Ibu Uji Aplikasi")).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Pesan air: alamat → 1 tangki → slot → ringkasan harga (zona) + Tunai saat air datang.
    await orderSteps(page);
    await expectNoHorizontalScroll(page);
    await page.getByLabel("Tunai saat air datang").check();
    await page.getByTestId("order-submit").getByRole("button", { name: "Kirim pesanan" }).click();
    await expect(page).toHaveURL(/\/app\/pesanan\/[0-9a-f-]{36}\?baru=1$/);
    await expect(page.getByTestId("order-created")).toContainText(/P-\d{2}-\d{6}/);
    await expect(page.getByTestId("order-status")).toHaveText("Diajukan");
    await expect(page.getByTestId("order-timeline")).toContainText("Menunggu konfirmasi kantor");
    await expect(page.getByTestId("order-payment")).toHaveText("Tunai saat air datang");

    // Batal sendiri sebelum truk berangkat (beralasan).
    await page.locator("summary", { hasText: "Batalkan pesanan" }).click();
    const cancel = page.getByTestId("cancel-order");
    await cancel.getByLabel("Alasan pembatalan").fill("Tandon ternyata masih penuh");
    await cancel.getByRole("button", { name: "Batalkan pesanan" }).click();
    await expect(page.getByTestId("order-status")).toHaveText("Dibatalkan");
    await expect(page.getByTestId("order-timeline")).toContainText("Tandon ternyata masih penuh");
  });

  test("US-P2-04 KP-3 US-P2-04 KP-4 US-P2-03 KP-1 pelanggan tertaut memesan dengan bayar di muka QRIS; status Berhasil diterima otomatis dari gerbang", async ({ page }) => {
    await ensureAppEnabled(page);
    await customerLogin(page, PLG_0019_PHONE);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText("Halo, Perumahan Bumi Pasir Hayam")).toBeVisible();

    await orderSteps(page);
    await page.getByLabel("Bayar sekarang (QRIS / virtual account)").check();
    await page.getByTestId("order-submit").getByRole("button", { name: "Kirim pesanan" }).click();
    await expect(page).toHaveURL(/\/app\/pesanan\/[0-9a-f-]{36}\?baru=1&bayar=1$/);
    const orderUrl = page.url();
    await page.getByTestId("pay-order").getByRole("button", { name: "Bayar sekarang (QRIS)" }).click();

    await expect(page).toHaveURL(/\/app\/bayar\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("payment-intent")).toContainText(/Bayar di muka pesanan P-\d{2}-\d{6}/);
    await expect(page.getByRole("img", { name: /Kode QRIS/ })).toBeVisible();
    await expect(page.getByTestId("payment-status")).toContainText("Menunggu");
    await page.getByTestId("simulate-payment").getByRole("button").click();
    await expect(page.getByTestId("payment-status")).toHaveText(/Pembayaran berhasil/, { timeout: 20_000 });

    await page.goto(orderUrl.replace(/\?.*$/, ""));
    await expect(page.getByTestId("order-payment")).toHaveText("Sudah dibayar (digital)");
    await expect(page.getByTestId("pay-order")).toHaveCount(0);

    // Riwayat & tagihan tampil di ponsel tanpa gulir mendatar.
    await page.goto("/app/pesanan");
    await expectNoHorizontalScroll(page);
    await page.goto("/app/tagihan");
    await expectNoHorizontalScroll(page);
  });
});
