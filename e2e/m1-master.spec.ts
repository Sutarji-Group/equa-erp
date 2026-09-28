import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/** Akun demo seed (src/db/seed/constants.ts). Dispatcher tanpa 2FA; pemilik wajib TOTP (PTB-35). */
const PASSWORD = "equa-demo-2026";
const OWNER_TOTP = "EQUADEMOPEMILIKRAHASIATOTPDEVAAA";

async function login(page: Page, username: string, totpSecret?: string) {
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill(username);
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  if (totpSecret) {
    await expect(page).toHaveURL(/\/masuk\/2fa$/);
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret: totpSecret }));
    await page.getByRole("button", { name: "Verifikasi" }).click();
    // Kode yang sama tidak boleh dipakai ulang dalam satu langkah waktu — tunggu langkah berikutnya bila ditolak.
    // (`isVisible` tidak menunggu: tunggu salah satu hasil — beranda atau pesan penolakan — agar tidak balapan.)
    const rejected = page.getByText(/Kode verifikasi salah/);
    const outcome = await Promise.race([
      page.waitForURL(/\/beranda$/, { timeout: 10_000 }).then(() => "ok" as const, () => "timeout" as const),
      rejected.waitFor({ state: "visible", timeout: 10_000 }).then(() => "rejected" as const, () => "timeout" as const),
    ]);
    if (outcome === "rejected") {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
      await page.getByLabel("Kode verifikasi").fill(await generate({ secret: totpSecret }));
      await page.getByRole("button", { name: "Verifikasi" }).click();
    }
  }
  await expect(page).toHaveURL(/\/beranda$/);
}

test.describe("Data master (M1)", () => {
  test("US-M1-01 KP-1 KP-7 dispatcher menambah pelanggan berkoordinat; nomor WA sama memunculkan kandidat duplikat", async ({ page }) => {
    const suffix = String(Date.now()).slice(-6);
    const name = `Hotel Uji E2E ${suffix}`;
    await login(page, "dispatcher1");

    await page.goto("/master/pelanggan");
    await expect(page.getByRole("heading", { level: 1, name: "Pelanggan", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Pelanggan baru" }).click();
    await expect(page).toHaveURL(/\/master\/pelanggan\/baru$/);

    await page.locator("#f-name").fill(name);
    await page.locator("#f-segment").selectOption("hotel");
    await page.locator("#f-waPhone").fill(`0812-77${suffix.slice(0, 2)}-${suffix.slice(2)}`);
    await page.locator("#f-addr_text").fill("Jl. Uji E2E No. 1, Cianjur");
    await page.locator("#f-addr_lat").fill("-6.8205");
    await page.locator("#f-addr_lng").fill("107.1405");
    await page.getByRole("button", { name: "Simpan pelanggan" }).click();

    await expect(page).toHaveURL(/\/master\/pelanggan\/[0-9a-f-]{36}\?baru=1$/);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText("Jl. Uji E2E No. 1, Cianjur").first()).toBeVisible();
    await expect(page.getByText("Tunai").first()).toBeVisible();

    // KP-7: nomor WA PLG-0001 (seed) → peringatan kandidat duplikat, tidak langsung tersimpan.
    await page.goto("/master/pelanggan/baru");
    await page.locator("#f-name").fill("Depot Tirta Sari Cabang");
    await page.locator("#f-segment").selectOption("third_party_depot");
    await page.locator("#f-waPhone").fill("0813-1000-0001");
    await page.locator("#f-addr_text").fill("Jl. Raya Cibeber No. 14, Cibeber");
    await page.getByRole("button", { name: "Simpan pelanggan" }).click();
    await expect(page.getByText("Kandidat duplikat")).toBeVisible();
    await expect(page.getByRole("link", { name: "Depot Air Tirta Sari" })).toBeVisible();
    await expect(page.getByText("Nomor WA sama")).toBeVisible();
    await expect(page).toHaveURL(/\/master\/pelanggan\/baru$/);
  });

  test("US-M1-06 KP-1 KP-2 laporan validasi impor: template terunduh, baris salah dikecualikan beralasan, duplikat digabung", async ({ page }) => {
    await login(page, "dispatcher1");
    await page.goto("/master/impor");
    await expect(page.getByRole("heading", { level: 1, name: "Impor data awal" })).toBeVisible();

    const template = await page.request.get("/master/impor/template/customers?contoh=1");
    expect(template.status()).toBe(200);
    expect(template.headers()["content-type"]).toContain("spreadsheetml");

    await page.getByRole("row").filter({ hasText: "uji-pelanggan-baru.xlsx" }).getByRole("link").click();
    await expect(page).toHaveURL(/\/master\/impor\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: /Impor Pelanggan/ })).toBeVisible();
    await expect(page.getByText('Format nomor WA salah ("0812-34"). Contoh: 0812-3456-7890.')).toBeVisible();
    await expect(page.getByText("Rumah tangga hanya tunai; tidak dapat Tempo migrasi (BR-04).")).toBeVisible();
    await expect(page.getByText(/Masih ada 2 baris/)).toBeVisible();

    // Baris salah → kecualikan dengan alasan.
    await page.getByRole("row").filter({ hasText: "PLG-0203" }).getByRole("button", { name: "Kecualikan" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Alasan").fill("Nomor WA belum dikonfirmasi pelanggan");
    await dialog.getByRole("button", { name: "Kecualikan" }).click();
    await expect(page.getByText("Alasan: Nomor WA belum dikonfirmasi pelanggan")).toBeVisible();
    await expect(page.getByText(/Masih ada 1 baris/)).toBeVisible();

    // Duplikat → gabungkan ke pelanggan yang ada (usulan).
    await page.getByRole("row").filter({ hasText: "PLG-0202" }).getByRole("button", { name: "Gabungkan ke sini" }).click();
    await expect(page.getByText("Digabung ke Depot Air Tirta Sari")).toBeVisible();
    await expect(page.getByText(/Masih ada \d+ baris/)).toHaveCount(0);
  });

  test("US-M1-06 KP-4 pemilik menandatangani ringkasan data awal; US-M1-05 KP-5 simulasi zona memuat harga saat ini", async ({ page }) => {
    await login(page, "pemilik", OWNER_TOTP);

    await page.goto("/master/tanda-tangan");
    await expect(page.getByRole("heading", { level: 1, name: "Tanda tangan data awal" })).toBeVisible();
    const form = page.getByRole("form", { name: "Tanda tangani Armada, kru, karyawan, peran, perangkat" });
    await form.getByLabel("Catatan (opsional)").fill("Sesuai daftar armada & karyawan per 1 Oktober");
    await form.getByRole("button", { name: "Tanda tangani ringkasan" }).click();
    await expect(page.getByText(/Ditandatangani .*Catatan: Sesuai daftar armada/)).toBeVisible();

    await page.goto("/master/zona");
    await expect(page.getByRole("heading", { level: 1, name: "Zona tarif" })).toBeVisible();
    await expect(page.getByText(/ [1-9]\d* alamat memiliki harga impor/)).toBeVisible();
    await expect(page.getByText("Depot Air Tirta Sari").first()).toBeVisible();
  });
});
