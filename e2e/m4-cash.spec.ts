import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/**
 * M4 — Kas & Setoran (web kantor) di atas data demo `src/db/seed/demo-m4-cash.ts`:
 * setoran sopir3 (Dede Rohmat) kemarin Diajukan dengan BBM menunggu verifikasi, setoran shift D02 & TK1 kemarin belum
 * diterima (demo M6/M7), selisih sopir6 (Yayan Sopyan) menunggu keputusan pemilik, ganti rugi aktif.
 * Alur: Admin Keuangan menerima setoran (selisih kurang ≥ ambang beralasan) → menerima setoran shift → menutup kas
 * kemarin; pemilik (ponsel) memutuskan selisih satu ketuk dan menolak satu selisih → ganti rugi tercatat.
 */

/** Akun demo seed (src/db/seed/constants.ts). */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
};

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

/** Tanggal bisnis WIB (YYYY-MM-DD) relatif hari ini. */
function wibDate(offsetDays = 0): string {
  return new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Buka rincian setoran dari daftar "Menunggu diterima" berdasarkan teks baris. */
async function openWaitingDeposit(page: Page, rowText: string | RegExp): Promise<void> {
  await page.goto("/kas/setoran");
  const row = page.getByTestId("setoran-menunggu").getByRole("row").filter({ hasText: rowText });
  await expect(row).toHaveCount(1);
  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/kas\/setoran\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("form-terima-setoran")).toBeVisible();
}

test.describe("M4 — Kas & Setoran (Admin Keuangan & pemilik)", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test("US-M4-01 KP-1 KP-5 US-M4-02 KP-1 KP-2 KP-3 KP-4 KP-6 Admin Keuangan: posisi kas per sumber; terima setoran sopir (verifikasi BBM, selisih kurang ≥ ambang beralasan, terlambat) → Ditutup & diteruskan ke pemilik", async ({ page }) => {
    await login(page, "keuangan1");

    // Kas hari ini: satu baris per sumber per lini + kas kantor; riwayat per tanggal & ekspor.
    await page.goto(`/kas?tanggal=${wibDate(-1)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Kas hari ini" })).toBeVisible();
    await expect(page.getByTestId("kas-driver")).toContainText("Dede Rohmat");
    await expect(page.getByTestId("kas-depot")).toContainText("D02");
    await expect(page.getByTestId("kas-store")).toContainText("TK1");
    const xlsx = await page.request.get(`/api/export/m4.cash_position?format=xlsx&date=${wibDate(-1)}`);
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");

    // Setoran sopir kemarin: rincian seharusnya per rit (dihitung sistem), BBM menunggu verifikasi.
    await openWaitingDeposit(page, "Dede Rohmat");
    await expect(page.getByTestId("rincian-seharusnya")).toContainText("Rit");
    await expect(page.getByTestId("pengeluaran-rit")).toContainText("Menunggu verifikasi");
    const form = page.getByTestId("form-terima-setoran");
    await form.getByRole("radio", { name: "Terima" }).check();
    const calc = form.getByTestId("hitung-selisih");
    const expected = Number(await calc.getAttribute("data-expected-net"));
    expect(expected).toBeGreaterThan(60_000);
    await form.getByLabel("Jumlah fisik diterima (Rp)").fill(String(expected - 60_000));
    await expect(calc).toContainText("-Rp 60.000");
    await expect(calc).toContainText("diteruskan ke pemilik");
    // Alasan selisih wajib dari daftar; diterima hari berikutnya → alasan terlambat wajib.
    await form.getByLabel("Alasan selisih").selectOption({ label: "Uang rusak/palsu" });
    await form.getByLabel(/Keterangan/).fill("Satu lembar Rp50.000 palsu dan Rp10.000 robek");
    await form.getByLabel(/Alasan terlambat/).fill("Sopir setor setelah kantor tutup");
    await form.getByRole("button", { name: "Terima setoran" }).click();

    // Setoran Ditutup (tidak menunggu keputusan pemilik); selisih Dijelaskan → keputusan pemilik.
    await expect(page.getByText("Hasil penerimaan")).toBeVisible();
    await expect(page.getByTestId("form-terima-setoran")).toHaveCount(0);
    await expect(page.getByText("Ditutup").first()).toBeVisible();
    const disc = page.getByTestId("selisih-setoran");
    await expect(disc).toContainText("-Rp 60.000");
    await expect(disc).toContainText("Uang rusak/palsu");
    await expect(disc).toContainText("Keputusan pemilik");
    await expect(page.getByTestId("pengeluaran-rit")).toContainText("Diterima");
  });

  test("US-M4-02 KP-7 US-M4-06 KP-1 KP-3 KP-4 Admin Keuangan: terima setoran shift depot & toko, lalu tutup kas kemarin (tanpa penghalang, kas kantor cocok)", async ({ page }) => {
    await login(page, "keuangan1");
    const yesterday = wibDate(-1);

    // Kas kemarin masih terhalang setoran shift depot D02 & toko TK1.
    await page.goto(`/kas/tutup?tanggal=${yesterday}`);
    await expect(page.getByRole("heading", { level: 1, name: "Tutup kas" })).toBeVisible();
    const blockers = page.getByTestId("penghalang-tutup-kas");
    await expect(blockers).toContainText("D02");
    await expect(blockers).toContainText("TK1");
    await expect(blockers).not.toContainText("Dede Rohmat");
    await expect(page.getByTestId("form-tutup-kas").getByRole("button", { name: "Tutup kas" })).toBeDisabled();

    for (const source of ["Depot D02", "Toko TK1"]) {
      await openWaitingDeposit(page, source);
      const form = page.getByTestId("form-terima-setoran");
      const calc = form.getByTestId("hitung-selisih");
      const expected = Number(await calc.getAttribute("data-expected-net"));
      await form.getByLabel("Jumlah fisik diterima (Rp)").fill(String(expected));
      await expect(calc).toContainText("Rp 0");
      await form.getByLabel(/Alasan terlambat/).fill("Setoran shift diterima pagi berikutnya");
      await form.getByRole("button", { name: "Terima setoran" }).click();
      await expect(page.getByText("Hasil penerimaan")).toBeVisible();
    }

    // Tanpa penghalang → hitung fisik kas kantor = saldo sistem → Tutup kas.
    await page.goto(`/kas/tutup?tanggal=${yesterday}`);
    await expect(page.getByText("Tidak ada penghalang")).toBeVisible();
    const fields = page.getByTestId("isian-tutup-kas");
    const system = Number(await fields.getAttribute("data-system-amount"));
    const close = page.getByTestId("form-tutup-kas");
    await close.getByLabel("Hitung fisik kas kantor (Rp)").fill(String(system));
    await close.getByRole("button", { name: "Tutup kas" }).click();
    await expect(page.getByText("Kas kantor saat tutup")).toBeVisible();
    await expect(page.getByTestId("form-tutup-kas")).toHaveCount(0);
    await expect(page.getByTestId("riwayat-hari-kas").getByRole("row").nth(1)).toContainText("Ditutup");
    // Hari yang ditutup terkunci: layar tetap menampilkan ringkasan, tidak ada formulir.
    await page.goto("/kas/setoran");
    await expect(page.getByTestId("setoran-menunggu").getByRole("row").filter({ hasText: /Depot D02|Toko TK1|Dede Rohmat/ })).toHaveCount(0);
  });

  test("US-M4-03 KP-1 KP-2 KP-4 US-M4-06 KP-6 pemilik (ponsel): setujui selisih satu ketuk; tolak selisih beralasan → ganti rugi karyawan tercatat", async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await login(page, "pemilik");

    await page.goto("/kas/selisih");
    await expect(page.getByRole("heading", { level: 1, name: "Selisih" })).toBeVisible();
    const list = page.getByTestId("daftar-selisih");
    const fresh = list.getByRole("row").filter({ hasText: "Dede Rohmat" });
    await expect(fresh).toContainText("-Rp 60.000");
    await expect(fresh).toContainText("Uang rusak/palsu");
    await fresh.getByRole("button", { name: "Setujui" }).click();
    await expect(page.getByText("Selisih disetujui").first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("daftar-selisih").getByRole("row").filter({ hasText: "Dede Rohmat" })).toHaveCount(0);

    // Selisih sopir6 (demo) ditolak dengan alasan → ganti rugi aktif → tercatat per kejadian.
    const old = page.getByTestId("daftar-selisih").getByRole("row").filter({ hasText: "Yayan Sopyan" });
    await expect(old).toContainText("-Rp 55.000");
    await old.getByRole("button", { name: "Tolak" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Alasan").fill("Tidak ada bukti uang palsu");
    await dialog.getByRole("button", { name: "Tolak" }).click();
    await expect(page.getByText("Selisih ditolak").first()).toBeVisible();

    await page.goto("/kas/selisih?tampil=semua");
    const all = page.getByTestId("daftar-selisih");
    await expect(all.getByRole("row").filter({ hasText: "Dede Rohmat" })).toContainText("Selesai");
    await expect(all.getByRole("row").filter({ hasText: "Yayan Sopyan" })).toContainText("Ditindaklanjuti");

    await page.goto("/kas/ganti-rugi");
    await expect(page.getByTestId("saldo-ganti-rugi")).toContainText("Yayan Sopyan");
    const rest = page.getByTestId("daftar-ganti-rugi").getByRole("row").filter({ hasText: "Yayan Sopyan" });
    await expect(rest).toContainText("Rp 55.000");
    await expect(rest).toContainText("Tidak ada bukti uang palsu");
  });
});
