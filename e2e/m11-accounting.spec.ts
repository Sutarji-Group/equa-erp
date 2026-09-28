import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { seedId } from "../src/db/seed/ids";

/** Akun demo seed (src/db/seed/constants.ts): pemilik & Admin Keuangan wajib 2FA; akuntan tanpa 2FA. */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
};
const account = (code: string) => seedId(`account:${code}`);
const PDF = Buffer.from("%PDF-1.4\n%bukti uji e2e\n");
/** Periode berjalan (WIB). */
const PERIOD = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 7);

async function login(page: Page, username: "pemilik" | "keuangan1" | "akuntan"): Promise<void> {
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

test.describe("M11 — Akuntansi & Pajak", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("US-M11-03 KP-1 US-M11-03 KP-3 US-M11-04 KP-1 US-M11-04 KP-3 Admin Keuangan: jurnal manual berlampiran terposting, dibalik beralasan, laporan per lini & buku besar menurun ke jurnal", async ({ page }) => {
    await login(page, "keuangan1");

    await page.goto("/akuntansi");
    await expect(page.getByRole("heading", { level: 1, name: "Akuntansi & Pajak" })).toBeVisible();
    await page.goto("/akuntansi/jurnal");
    await expect(page.getByTestId("tabel-jurnal")).toContainText("JD-");

    // Jurnal manual dari template pemeliharaan + lampiran PDF → terposting (≤ PAR-20) & masuk tinjauan pemilik.
    await page.goto("/akuntansi/jurnal/baru?template=maintenance");
    const form = page.getByTestId("form-jurnal-manual");
    await form.getByLabel("Keterangan").fill("Servis pompa depot D01 (uji E2E)");
    await form.getByLabel("Akun baris 1").selectOption(account("6-1401"));
    await form.getByLabel("Pusat laba baris 1").selectOption("L3");
    await form.getByLabel("Debit baris 1").fill("250000");
    await form.getByLabel("Akun baris 2").selectOption(account("1-1101"));
    await form.getByLabel("Kredit baris 2").fill("250000");
    await form.getByLabel("Lampiran bukti (foto/PDF)").setInputFiles({ name: "bukti-servis.pdf", mimeType: "application/pdf", buffer: PDF });
    await form.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page).toHaveURL(/\/akuntansi\/jurnal\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Terposting").first()).toBeVisible();
    await expect(page.getByTestId("baris-jurnal")).toContainText("6-1401");
    await expect(page.getByTestId("baris-jurnal")).toContainText("(seimbang)");
    const journalUrl = page.url();

    // Koreksi = jurnal pembalik beralasan (≤ PAR-21 langsung terposting).
    await page.getByTestId("balik-jurnal").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Alasan").fill("Nota servis ganda dari bengkel (uji E2E)");
    await dialog.getByRole("button", { name: "Balik jurnal" }).click();
    await expect(page).not.toHaveURL(journalUrl);
    await expect(page.getByText("Pembalik").first()).toBeVisible();

    // Laporan keuangan per lini (Sementara) dan buku besar menurun ke jurnal.
    await page.goto(`/akuntansi/laporan?periode=${PERIOD}`);
    await expect(page.getByTestId("status-laporan")).toContainText("Sementara");
    await expect(page.getByTestId("tabel-laba-rugi")).toContainText("4-1101");
    await page.goto(`/akuntansi/laporan?periode=${PERIOD}&tab=neraca-saldo`);
    await expect(page.getByTestId("tabel-neraca-saldo")).toBeVisible();
    await page.goto(`/akuntansi/buku-besar?akun=${account("6-1401")}&dari=${PERIOD}`);
    await expect(page.getByTestId("tabel-buku-besar")).toContainText("Servis pompa depot D01");
    await page.getByTestId("tabel-buku-besar").getByRole("link", { name: /^J-/ }).first().click();
    await expect(page).toHaveURL(/\/akuntansi\/jurnal\/[0-9a-f-]{36}$/);

    // Rekonsiliasi & periode tampil untuk Admin Keuangan.
    await page.goto(`/akuntansi/rekonsiliasi?periode=${PERIOD}`);
    await expect(page.getByRole("heading", { level: 1, name: "Rekonsiliasi bank & kas" })).toBeVisible();
    await page.goto("/akuntansi/periode");
    await expect(page.getByTestId("tabel-periode")).toContainText(/\d{4}/);
  });

  test("US-M11-03 KP-2 US-M11-10 KP-1 pemilik menandai daftar tinjauan jurnal manual 'ditinjau'; prasyarat periode tampil dengan tautan tindakan", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto(`/akuntansi/jurnal?tinjauan=${PERIOD}`);
    const table = page.getByTestId("tabel-tinjauan");
    await expect(table).toContainText("Belum");
    await page.getByTestId("tandai-ditinjau").click();
    await expect(table).not.toContainText("Belum");
    await page.goto(`/akuntansi/periode/${PERIOD}`);
    await expect(page.getByTestId("prasyarat-periode")).toContainText("Daftar tinjauan");
    await expect(page.getByTestId("prasyarat-periode").getByRole("link", { name: "Kerjakan" }).first()).toBeVisible();
  });

  test("US-M11-02 KP-5 US-M11-08 KP-4 akuntan baca-saja: laporan, pajak & jurnal terlihat; tidak dapat membuat/membalik jurnal", async ({ page }) => {
    await login(page, "akuntan");
    await page.goto(`/akuntansi/laporan?periode=${PERIOD}`);
    await expect(page.getByTestId("tabel-laba-rugi")).toBeVisible();
    await page.goto("/akuntansi/pajak");
    await expect(page.getByTestId("pemantauan-pkp")).toContainText("dari batas");
    await page.goto("/akuntansi/akun");
    await expect(page.getByTestId("tabel-akun")).toContainText("1-1101");
    await expect(page.getByTestId("tambah-akun")).toHaveCount(0);
    await page.goto("/akuntansi/jurnal");
    await page.getByTestId("tabel-jurnal").getByRole("link", { name: /^JD-/ }).first().click();
    await expect(page.getByTestId("baris-jurnal")).toBeVisible();
    await expect(page.getByTestId("balik-jurnal")).toHaveCount(0);
    for (const [path, heading] of [
      ["/akuntansi/pemetaan", "Pemetaan jurnal otomatis"],
      ["/akuntansi/saldo-awal", "Saldo awal"],
      ["/akuntansi/utang", "Utang usaha"],
      ["/akuntansi/aset", "Aset tetap"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    }
    await expect(page.getByTestId("tabel-aset")).toContainText("AT-TRK-001");
    await page.getByTestId("tabel-aset").getByRole("link", { name: "AT-TRK-001" }).click();
    await expect(page.getByTestId("riwayat-penyusutan").or(page.getByText("Belum ada penyusutan"))).toBeVisible();
    await expect(page.getByTestId("lepas-aset")).toHaveCount(0);
    await page.goto("/akuntansi/jurnal/baru");
    await expect(page).toHaveURL(/\/beranda\?ditolak=1/);
  });
});
