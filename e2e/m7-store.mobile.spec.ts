import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { seedId } from "../src/db/seed/ids";

/** Akun demo seed (src/db/seed/constants.ts). */
const PASSWORD = "equa-demo-2026";
const ADMIN_TOTP = "EQUADEMOADMINSATURAHASIATOTPAAAA";
const PIN = "123456";
/** Tablet POS toko TK1 (seed) & kasirnya (kasir). */
const POS_DEVICE_ID = seedId("device:POS-TK1");
const CASHIER = "Fitri Handayani";

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

/** Teks rupiah terformat (`formatRupiah` memakai spasi tak putus setelah "Rp"). */
function rp(amount: string): RegExp {
  return new RegExp(`Rp\\s?${amount.replace(/\./g, "\\.")}`);
}

function digits(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9]/g, ""));
}

async function addProduct(page: Page, query: string, name: RegExp): Promise<void> {
  await page.getByLabel("Cari barang (nama, kode, barcode)").fill(query);
  await page.getByTestId("hasil-cari").getByRole("button", { name }).click();
}

test.describe("M7 — POS toko di tablet (offline-first)", () => {
  test.setTimeout(240_000);
  test("US-M7-01 KP-1/KP-2/KP-3/KP-4 US-M7-04 KP-2 US-M7-03 KP-2 US-M7-09 KP-1/KP-2 aktivasi tablet toko → PIN → buka shift → jual harga mitra → jual umum berdiskon saat offline → tempo mitra → tandai pesan ulang → tutup shift & setoran", async ({
    page,
    context,
  }) => {
    // Admin sistem menerbitkan kode aktivasi tablet POS toko (M10).
    await loginAdmin(page);
    await page.goto(`/akses/perangkat/${POS_DEVICE_ID}`);
    await page.getByText("Terbitkan kode aktivasi baru").click();
    await page.getByLabel("Alasan").last().fill("Tablet POS toko dipasang ulang (uji E2E)");
    await page.getByRole("button", { name: "Terbitkan kode" }).click();
    const code = (await page.getByTestId("kode-sekali").textContent())!.trim();
    expect(code.length).toBeGreaterThanOrEqual(6);
    await context.clearCookies();

    // Aktivasi → aplikasi POS (mode toko dari jenis outlet) → kasir + PIN.
    await page.goto("/aktivasi-perangkat");
    await page.getByLabel("Kode aktivasi").fill(code);
    await page.getByRole("button", { name: "Aktifkan" }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByRole("button", { name: new RegExp(CASHIER) }).click();
    for (const digit of PIN) await page.getByRole("button", { name: digit, exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Menu POS toko" })).toBeVisible({ timeout: 30_000 });

    // Buka shift (kas awal tetap dari sistem).
    const open = page.getByTestId("buka-shift");
    await expect(open).toBeVisible({ timeout: 30_000 });
    await open.getByRole("button", { name: "Buka shift" }).click();

    // US-M7-01 KP-1: pelanggan mitra → harga mitra otomatis.
    await expect(page.getByTestId("pilih-pelanggan")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Pelanggan").selectOption({ label: "Depot Barokah Cilaku — mitra toko" });
    await expect(page.getByTestId("jenis-harga")).toContainText("Harga mitra");
    await addProduct(page, "tutup", /Tutup galon/);
    await addProduct(page, "tutup", /Tutup galon/);
    await expect(page.getByTestId("total-toko")).toContainText(rp("1.200"));
    await page.getByTestId("simpan-transaksi-toko").click();
    const receipt = page.getByTestId("struk-toko");
    await expect(receipt).toContainText("Depot Barokah Cilaku");
    await expect(receipt).toContainText(rp("1.200"));
    await page.getByRole("button", { name: "Transaksi baru" }).click();
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // US-M7-01 KP-3 + offline: pelanggan umum, diskon ≤ 5% beralasan, tersimpan di tablet.
    await context.setOffline(true);
    await expect(page.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
    await page.getByLabel("Pelanggan").selectOption({ label: "Umum (harga umum, tunai/QRIS)" });
    await expect(page.getByTestId("jenis-harga")).toContainText("Harga umum");
    await addProduct(page, "sabun", /Sabun cuci galon/);
    await page.getByLabel("Diskon per transaksi (Rp)").fill("1000");
    await page.getByLabel("Alasan diskon").fill("Kemasan penyok");
    await expect(page.getByTestId("total-toko")).toContainText(rp("29.000"));
    await page.getByTestId("simpan-transaksi-toko").click();
    await expect(page.getByTestId("struk-toko")).toContainText("tersimpan di perangkat");
    await expect(page.getByTestId("struk-toko")).toContainText("Diskon");
    await expect(page.getByTestId("nomor-transaksi-toko")).toContainText(/TK1-\d{6}-POSTK1-\d{4}/);
    await page.getByRole("button", { name: "Transaksi baru" }).click();
    await context.setOffline(false);
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // US-M7-04 KP-2: tempo mitra → struk menyebut faktur (terbit setelah terkirim, M5).
    await page.getByLabel("Pelanggan").selectOption({ label: "Depot Air Tirta Sari — mitra toko" });
    await addProduct(page, "sikat", /Sikat galon/);
    await page.getByRole("radio", { name: "Tempo mitra" }).click();
    await expect(page.getByText(/Sisa batas kredit/)).toBeVisible();
    await page.getByTestId("simpan-transaksi-toko").click();
    await expect(page.getByTestId("faktur-tempo")).toBeVisible();
    await page.getByRole("button", { name: "Transaksi baru" }).click();
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // US-M7-03 KP-2: daftar pesan ulang (seed: lampu UV & filter di bawah minimum) → tandai sudah dipesan.
    await page.getByRole("button", { name: "Stok & opname" }).click();
    await page.getByRole("radio", { name: /Pesan ulang/ }).click();
    const reorder = page.getByTestId("pesan-ulang");
    const uv = reorder.locator("li", { hasText: "Lampu UV 40 watt" });
    await uv.getByLabel("Pemasok Lampu UV 40 watt").selectOption({ label: "UD Filter Jaya Bandung" });
    await uv.getByRole("button", { name: "Sudah dipesan" }).click();
    await expect(uv.getByRole("button", { name: "Sudah dipesan" })).toHaveCount(0, { timeout: 30_000 });
    await expect(uv).toContainText("UD Filter Jaya Bandung");
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // US-M7-09: tutup shift — kas fisik = tunai seharusnya (tempo & QRIS tidak masuk laci) → serah setoran.
    await page.getByRole("button", { name: "Shift & kas" }).click();
    const close = page.getByTestId("tutup-shift");
    const expected = digits(await close.getByTestId("tunai-seharusnya").textContent());
    expect(expected).toBe(200_000 + 1_200 + 29_000);
    await close.getByLabel("Kas fisik di laci (hitung)").fill(String(expected));
    await close.getByRole("button", { name: "Tutup shift" }).click();
    const handover = page.getByTestId("serah-setoran");
    await expect(handover).toBeVisible({ timeout: 30_000 });
    await expect(handover).toContainText(rp("30.200"));
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });
  });
});
