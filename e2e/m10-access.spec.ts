import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/** Akun demo seed (src/db/seed/constants.ts). */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  admin1: "EQUADEMOADMINSATURAHASIATOTPAAAA",
};
const usedCodes = new Set<string>();

/** Masuk web kantor dengan kata sandi + TOTP demo (kode tidak dipakai ulang dalam langkah waktu yang sama). */
async function login(page: Page, username: "pemilik" | "admin1"): Promise<void> {
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill(username);
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/masuk\/2fa$/);
  for (let attempt = 0; attempt < 3; attempt++) {
    let code = await generate({ secret: TOTP[username]! });
    if (usedCodes.has(`${username}:${code}`)) {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
      code = await generate({ secret: TOTP[username]! });
    }
    usedCodes.add(`${username}:${code}`);
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

async function logout(page: Page): Promise<void> {
  await page.context().clearCookies();
}

test.describe("M10 — Pengguna, hak akses & jejak audit", () => {
  test.describe.configure({ mode: "serial" });

  test("US-M10-01 KP-4 KP-8 admin sistem mengajukan peran tambahan → pemilik menyetujui satu ketuk di kotak persetujuan → peran aktif", async ({ page }) => {
    await login(page, "admin1");
    await page.goto("/akses/pengguna?q=dispatcher2");
    await expect(page.getByRole("heading", { level: 1, name: "Pengguna" })).toBeVisible();
    await page.getByRole("link", { name: "Neng Siti Nurhasanah" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Neng Siti Nurhasanah" })).toBeVisible();

    const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    // Kombinasi terlarang PTB-31 tidak dapat diajukan sama sekali (Dispatcher + Admin Keuangan).
    await page.getByText("Ajukan pindah peran / peran tambahan").click();
    const bad = page.getByTestId("form-peran");
    await bad.getByLabel("Jenis permintaan").selectOption("add");
    await bad.getByLabel("Peran", { exact: true }).selectOption("finance_admin");
    await bad.getByLabel(/Masa berlaku/).fill(until);
    await bad.getByLabel("Alasan").fill("Merangkap kasir kantor");
    await bad.getByRole("button", { name: "Ajukan ke pemilik" }).click();
    await expect(bad.getByRole("alert")).toContainText(/tidak dapat diajukan/);

    // Peran tambahan yang sah: alasan + masa berlaku → menunggu persetujuan pemilik.
    await page.reload();
    await page.getByText("Ajukan pindah peran / peran tambahan").click();
    const form = page.getByTestId("form-peran");
    await form.getByLabel("Jenis permintaan").selectOption("add");
    await form.getByLabel("Peran", { exact: true }).selectOption("accountant");
    await form.getByLabel(/Masa berlaku/).fill(until);
    await form.getByLabel("Alasan").fill("Membantu rekap tutup buku kuartal");
    await form.getByRole("button", { name: "Ajukan ke pemilik" }).click();
    await expect(form.getByRole("status")).toContainText(/diajukan ke pemilik/);

    await logout(page);
    await login(page, "pemilik");
    await page.goto("/persetujuan");
    const card = page.locator("li", { hasText: "Satu orang lebih dari satu peran" }).filter({ hasText: "Membantu rekap tutup buku" }).first();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Setujui" }).click();
    await expect(page.getByText(/disetujui/).first()).toBeVisible();

    await page.goto("/akses/pengguna?q=dispatcher2");
    await expect(page.getByRole("cell", { name: /Akuntan/ })).toBeVisible();
  });

  test("US-M10-02 KP-1 admin sistem mendaftarkan perangkat → kode aktivasi tampil sekali; US-M10-07 KP-1 halaman perangkat & sinkron", async ({ page }) => {
    await login(page, "admin1");
    await page.goto("/akses/perangkat");
    await expect(page.getByRole("heading", { level: 1, name: "Perangkat" })).toBeVisible();
    const form = page.getByTestId("form-daftar-perangkat");
    await form.getByLabel("Kode perangkat (label aset/IMEI)").fill(`HP-E2E-${Date.now() % 100000}`);
    await form.getByLabel("Nama").fill("Ponsel uji E2E");
    await form.getByLabel("Unit").selectOption({ index: 1 });
    await form.getByRole("button", { name: "Daftarkan & buat kode aktivasi" }).click();
    const code = form.getByTestId("kode-sekali");
    await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await page.reload();
    await expect(page.getByTestId("kode-sekali")).toHaveCount(0);

    await page.goto("/akses/sinkron");
    await expect(page.getByRole("heading", { level: 1, name: "Perangkat & sinkron" })).toBeVisible();
    await expect(page.getByTestId("tabel-sinkron")).toContainText("HP-T4");
    await expect(page.getByText("perlu pembaruan").first()).toBeVisible();
  });

  test("US-M10-03 KP-4 pemilik melihat & mengekspor matriks peran; US-M10-01 KP-6 menandai tinjauan kuartal; US-M10-05 KP-4 log akses terpisah", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto("/akses/peran");
    await expect(page.getByRole("heading", { level: 1, name: "Peran & matriks" })).toBeVisible();
    await expect(page.getByTestId("matriks-peran")).toContainText("Menerima setoran & menghitung selisih");
    await expect(page.getByRole("link", { name: /Excel/ })).toHaveAttribute("href", /core\.rbac_matrix\?format=xlsx/);
    const res = await page.request.get("/api/export/core.rbac_matrix?format=xlsx");
    expect(res.status()).toBe(200);

    await page.goto("/akses/tinjauan");
    await expect(page.getByTestId("tabel-tinjauan")).toContainText("keuangan1");
    const form = page.getByTestId("form-tinjauan");
    await form.getByLabel(/Catatan/).fill("Tinjauan E2E: semua akun sesuai");
    await form.getByRole("button", { name: /ditinjau/ }).click();
    await expect(form.getByRole("status").or(page.getByText("Hasil tinjauan"))).toBeVisible();

    await page.goto("/audit?tab=akses");
    await expect(page.getByTestId("tabel-log-akses")).toContainText("Login berhasil");
  });
});
