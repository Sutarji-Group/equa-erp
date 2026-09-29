import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/**
 * P2 — Aplikasi Pelanggan (Tahap 2), sisi kantor. Data demo: src/db/seed/demo-p2-customer.ts (akun PLG-0019 &
 * PLG-0037 tertaut, akun "Rudi Hartono" menunggu verifikasi, pesanan aplikasi PLG-0037 lewat tenggat, keluhan tagihan
 * lewat tenggat di kotak Admin Keuangan). Flag `phase2.customer_app` bawaan mati (D-02) → pemilik mengaktifkannya.
 */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
};

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

test.describe("P2 — Aplikasi Pelanggan (kantor)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("US-P2-01 KP-2 pemilik mengaktifkan aplikasi pelanggan (D-02) dan melihat akun menunggu verifikasi nama (8.7)", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto("/keluhan/akun");
    await expect(page.getByRole("heading", { level: 1, name: "Akun pelanggan" })).toBeVisible();
    const toggle = page.getByTestId("toggle-app");
    if (await toggle.getByRole("button", { name: "Aktifkan aplikasi pelanggan" }).isVisible()) {
      await toggle.locator('input[name="reason"]').fill("Prasyarat TG-9 terpenuhi (uji E2E)");
      await toggle.getByRole("button", { name: "Aktifkan aplikasi pelanggan" }).click();
      await expect(toggle.getByRole("button", { name: "Nonaktifkan aplikasi" })).toBeVisible();
    }
    await page.reload();
    await expect(page.getByTestId("toggle-app").getByRole("button", { name: "Nonaktifkan aplikasi" })).toBeVisible();
    await expect(page.getByTestId("account-requests")).toContainText("Rudi Hartono");
    await expect(page.getByTestId("account-requests")).toContainText("Bapak Enjang Sutisna");
    await expect(page.getByTestId("accounts")).toContainText("Kolam Renang Tirta Kencana");

    // Laporan adopsi pemilik (8.2): akun terhubung, penilaian, keluhan.
    await page.goto("/keluhan/laporan");
    await expect(page.getByTestId("adoption")).toContainText("Akun terhubung");
    await expect(page.getByTestId("complaints-by-kind")).toContainText("Tagihan");
  });

  test("US-P2-02 KP-4 Dispatcher melihat pesanan aplikasi lewat tenggat PAR-75 lalu mengonfirmasinya", async ({ page }) => {
    await login(page, "dispatcher1");
    await page.goto("/keluhan/pesanan-aplikasi");
    const list = page.getByTestId("app-orders");
    await expect(list).toContainText("Kolam Renang Tirta Kencana");
    await expect(list).toContainText("Lewat tenggat konfirmasi");
    const form = page.locator('[data-testid^="confirm-P-"][data-testid$="-900101"]');
    await form.locator('input[name="note"]').fill("Dijadwalkan truk pagi");
    await form.getByRole("button", { name: "Konfirmasi" }).click();
    // Sudah dikonfirmasi → keluar dari daftar "Menunggu konfirmasi".
    await expect(form).toHaveCount(0);
    await page.goto("/keluhan/pesanan-aplikasi?tampil=semua");
    await expect(page.getByTestId("app-orders")).toContainText("Dikonfirmasi");
  });

  test("US-P2-06 KP-2 US-P2-06 KP-3 Admin Keuangan menanggapi keluhan tagihan di kotaknya lalu menutupnya dengan penyelesaian", async ({ page }) => {
    await login(page, "keuangan1");
    await page.goto("/keluhan");
    await expect(page.getByRole("heading", { level: 1, name: "Kotak keluhan" })).toBeVisible();
    const table = page.getByTestId("complaint-table");
    const row = table.getByRole("row").filter({ hasText: "Kolam Renang Tirta Kencana" });
    await expect(row).toContainText("Tagihan");
    await expect(row).toContainText("Lewat tenggat");
    await row.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/keluhan\/[0-9a-f-]{36}$/);

    const respond = page.getByTestId("respond-form");
    await respond.locator('textarea[name="response"]').fill("Kami cek catatan rit bulan lalu; faktur dikoreksi bila memang 5 tangki.");
    await respond.getByRole("button", { name: "Kirim tanggapan" }).click();
    await expect(page.getByText("Kami cek catatan rit bulan lalu; faktur dikoreksi bila memang 5 tangki.").first()).toBeVisible();

    const resolve = page.getByTestId("resolve-form");
    await resolve.locator('textarea[name="resolution"]').fill("Terbukti 5 tangki; nota kredit 1 tangki diterbitkan.");
    await resolve.getByRole("button", { name: "Tutup dengan penyelesaian" }).click();
    // Keluhan Selesai → formulir tanggapan hilang; penyelesaian tercatat di riwayat tindakan.
    await expect(page.getByTestId("resolve-form")).toHaveCount(0);
    await expect(page.getByText("Terbukti 5 tangki; nota kredit 1 tangki diterbitkan.")).toBeVisible();

    await page.goto("/keluhan?kotak=finance_admin&status=selesai");
    await expect(page.getByTestId("complaint-table").getByRole("row").filter({ hasText: "Kolam Renang Tirta Kencana" })).toContainText("Selesai");
  });
});
