import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/**
 * M8 — Produksi & Stok Air (web kantor) di atas data demo `src/db/seed/demo-m8-production.ts`:
 * SA1 H-2 susut di atas PAR-18 dengan penjelasan operator (Investigasi), SA1 H-1 produksi menyimpang > PAR-68, SA2 H-2
 * susut negatif; rit T3/T4 hari ini; jadwal & hasil uji mutu (D01 tidak lulus, tindakan terbuka).
 * Alur: pemilik membaca neraca harian/bulanan & menerima penjelasan susut → Selesai; utilisasi & mutu air.
 * Admin Keuangan memverifikasi produksi menyimpang & susut negatif, melihat pengisian vs jadwal & pasokan depot, mencatat
 * stok air awal depot (B-10), dan menandai tindakan uji mutu selesai.
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

/** Tanggal bisnis WIB (YYYY-MM-DD) relatif hari ini. */
function wibDate(offsetDays = 0): string {
  return new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

test.describe("M8 — Produksi & Stok Air (pemilik & Admin Keuangan)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("US-M8-04 KP-1 KP-2 KP-4 US-M8-05 KP-1 US-M8-06 KP-3 pemilik: neraca harian & bulanan, terima penjelasan susut → Selesai; utilisasi & riwayat mutu air", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto("/produksi/neraca-air");
    await expect(page.getByRole("heading", { level: 1, name: "Neraca air" })).toBeVisible();
    const table = page.getByTestId("tabel-neraca");
    await expect(table).toContainText("Sumber Air Cugenang");
    await expect(table).toContainText("Investigasi");
    await expect(table).toContainText("Susut negatif");
    // Daftar kerja → rincian SA1 H-2 (penjelasan operator + foto) → pemilik menerima.
    const work = page.getByTestId("daftar-kerja");
    await expect(work).toBeVisible();
    await page.goto(`/produksi/neraca-air/rincian?sumber=${await sourceIdFromTable(page, "Sumber Air Cugenang")}&tanggal=${wibDate(-2)}`);
    await expect(page.getByTestId("penjelasan-susut")).toContainText("Kebocoran");
    const accept = page.getByTestId("form-terima-susut");
    await accept.getByLabel("Catatan (opsional)").fill("Diterima — pipa sudah diperbaiki");
    await accept.getByRole("button", { name: "Terima penjelasan" }).click();
    // Status berubah Investigasi → Selesai (formulir hilang setelah revalidasi; catatan pemilik tampil).
    await expect(page.getByTestId("form-terima-susut")).toHaveCount(0);
    await expect(page.getByTestId("penjelasan-susut")).toContainText("Catatan pemilik: Diterima — pipa sudah diperbaiki");

    // KP-4: neraca bulanan per sumber + gabungan & ekspor.
    await page.goto("/produksi/neraca-air?tab=bulanan");
    const monthly = page.getByTestId("tabel-neraca-bulanan");
    await expect(monthly).toContainText("Gabungan semua sumber");
    await expect(page.getByRole("link", { name: "Unduh Excel" }).first()).toHaveAttribute("href", /m8\.water_balance_monthly/);

    // US-M8-05: utilisasi per sumber & gabungan + ekspor 6 bulan (pemilik).
    await page.goto("/produksi/utilisasi");
    await expect(page.getByTestId("tabel-utilisasi-bulanan")).toContainText("Sumber Air Cugenang");
    await expect(page.getByTestId("info-ekspor-6-bulan")).toContainText("6 bulan");

    // US-M8-06: jadwal uji & riwayat hasil (tindakan tidak lulus terbuka).
    await page.goto("/produksi/mutu");
    await expect(page.getByTestId("tabel-jadwal-uji")).toContainText("Sumber Air Cugenang");
    await expect(page.getByTestId("tabel-hasil-uji")).toContainText("Tidak lulus");
  });

  test("US-M8-01 KP-4 US-M8-04 KP-5 US-M8-02 KP-2 US-M8-03 KP-2 US-M8-06 KP-2 Admin Keuangan: verifikasi produksi menyimpang & susut negatif; pengisian vs jadwal; pasokan depot; stok air awal depot; tindakan uji mutu", async ({ page }) => {
    await login(page, "keuangan1");
    await page.goto("/produksi/neraca-air");
    const sa1 = await sourceIdFromTable(page, "Sumber Air Cugenang");
    const sa2 = await sourceIdFromTable(page, "Sumber Air Warungkondang");

    // US-M8-01 KP-4: produksi SA1 H-1 menyimpang dari rata-rata → foto dibandingkan → diverifikasi.
    await page.goto(`/produksi/neraca-air/rincian?sumber=${sa1}&tanggal=${wibDate(-1)}`);
    const verify = page.getByTestId("verifikasi-produksi");
    await expect(verify).toContainText("menyimpang");
    await verify.getByLabel("Hasil pembandingan foto meter").fill("Foto meter pagi & malam sesuai angka; produksi naik karena pompa baru");
    await verify.getByRole("button", { name: "Verifikasi produksi" }).click();
    await expect(page.getByTestId("verifikasi-produksi")).toHaveCount(0);
    await expect(page.getByText(/^Diverifikasi /).first()).toBeVisible();

    // US-M8-04 KP-5: susut negatif SA2 H-2 wajib verifikasi Admin Keuangan.
    await page.goto(`/produksi/neraca-air/rincian?sumber=${sa2}&tanggal=${wibDate(-2)}`);
    const neg = page.getByTestId("form-verifikasi-negatif");
    await neg.getByLabel("Hasil verifikasi").fill("Angka meter malam salah baca 200 L; dicek ulang bersama operator");
    await neg.getByRole("button", { name: "Verifikasi susut negatif" }).click();
    await expect(page.getByTestId("form-verifikasi-negatif")).toHaveCount(0);
    await expect(page.getByText("Verifikasi Admin Keuangan: Angka meter malam salah baca 200 L").first()).toBeVisible();

    // US-M8-02 KP-2: pengisian vs jadwal rit hari ini (T3 SA1, T4 SA2) + semua pengisian (ekspor).
    await page.goto("/produksi/pengisian");
    const board = page.getByTestId("tabel-jadwal-isi");
    await expect(board).toContainText("T3");
    await expect(board).toContainText("Belum diisi");
    await page.getByRole("link", { name: "Semua pengisian" }).click();
    await expect(page.getByTestId("tabel-pengisian")).toContainText("T3");
    await expect(page.getByRole("link", { name: "Unduh Excel" }).first()).toHaveAttribute("href", /m8\.truck_fills/);

    // US-M8-03: pasokan depot (tiga angka) & ringkasan; B-10 stok air awal depot saat cut-over.
    await page.getByRole("link", { name: "Pasokan depot" }).click();
    await expect(page.getByText("Pasokan per rit (tiga angka)")).toBeVisible();
    await expect(page.getByText(/Ringkasan pasokan per depot per hari/)).toBeVisible();
    await page.getByRole("link", { name: "Stok air awal depot" }).click();
    const opening = page.getByTestId("form-stok-awal");
    await expect(opening).toBeVisible();
    await opening.getByLabel("Depot").selectOption({ index: 1 });
    await opening.getByLabel("Jumlah air (L)").fill("1200");
    await opening.getByLabel("Dasar angka").fill("Ukur toren bersama operator depot saat cut-over (uji E2E)");
    const depotLabel = (await opening.getByLabel("Depot").locator("option").nth(1).textContent())!;
    await opening.getByRole("button", { name: "Simpan stok awal" }).click();
    await expect(page.getByTestId("tabel-stok-awal").getByRole("row").filter({ hasText: depotLabel })).toContainText("1.200 L");

    // US-M8-06 KP-2: tindakan uji mutu D01 ditandai selesai (berjejak).
    await page.goto("/produksi/mutu");
    const results = page.getByTestId("tabel-hasil-uji");
    const failedRow = results.getByRole("row").filter({ hasText: "Tidak lulus" }).first();
    await failedRow.getByText("Tandai selesai…").click();
    await failedRow.getByLabel("Hasil tindakan").fill("Toren disterilisasi & filter UV diganti; uji ulang dijadwalkan");
    await failedRow.getByRole("button", { name: "Tandai selesai" }).click();
    await expect(results.getByRole("row").filter({ hasText: "Tidak lulus" }).first()).toContainText("Selesai");
  });
});

/** ID sumber air dari tautan rincian pada tabel neraca (baris pertama sumber itu). */
async function sourceIdFromTable(page: Page, sourceName: string): Promise<string> {
  const row = page.getByTestId("tabel-neraca").getByRole("row").filter({ hasText: sourceName }).first();
  const href = (await row.getByRole("link").first().getAttribute("href"))!;
  return new URL(href, "http://x").searchParams.get("sumber")!;
}
