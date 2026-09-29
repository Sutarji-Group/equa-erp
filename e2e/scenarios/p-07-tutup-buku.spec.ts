import { expect, test, type Page } from "@playwright/test";

import { seedId } from "../../src/db/seed/ids";

import { addDays, attachAllPages, cronTick, digits, firstOfNextMonth, matchOpenTransfers, officeSession, offsetTo, setClock, wibDate, wibInstant } from "./helpers";

/**
 * P-07 — Tutup buku bulanan (BRD Bab 5; PRD US-M11-02, US-M11-03, US-M11-06, US-M11-10, US-M9-02).
 *
 * Dijalankan SESUDAH P-01..P-06 (urutan berkas proyek `scenarios`): transaksi skenario bulan berjalan sudah menjadi
 * jurnal otomatis (langkah 1) — mis. selisih kas D01 yang disetujui pemilik di P-06 masuk beban selisih kas. Admin
 * Keuangan membuat jurnal akrual > PAR-20 berlampiran → pemilik menyetujui (langkah 2–3) dan menandai tinjauan;
 * rekonsiliasi bank & kas nol selisih (langkah 4); laba kotor per lini "Sementara" (langkah 5); pada tanggal 1 bulan
 * berikutnya (jam kantor tersuntik E2E) Admin Keuangan menutup periode (langkah 6) → pemilik mengunci → laporan "Final".
 */
const account = (code: string) => seedId(`account:${code}`);
const PDF = Buffer.from("%PDF-1.4\n%bukti akrual skenario P-07\n");
const ACCRUAL = 6_500_000;

/** Nilai rupiah bertanda dari teks ("-Rp 1.250" → −1250). */
function signedRupiah(text: string): number {
  const neg = /^[-−]/.test(text.trim());
  return (neg ? -1 : 1) * digits(text);
}

/** Pemilik menyetujui semua permintaan bertipe `typeLabel` yang menunggu di /persetujuan. */
async function approveAll(page: Page, typeLabel: string, filter?: RegExp): Promise<number> {
  let n = 0;
  for (; n < 15; n++) {
    await page.goto("/persetujuan");
    let item = page.locator("li").filter({ hasText: typeLabel });
    if (filter) item = item.filter({ hasText: filter });
    if (!(await item.first().isVisible())) break;
    await item.first().getByRole("button", { name: "Setujui" }).click();
    await expect(page.getByText(/Permintaan A-\d{2}-\d+ disetujui/).first()).toBeVisible();
  }
  return n;
}

test.describe("P-07 tutup buku bulanan — jurnal otomatis, jurnal manual, rekonsiliasi, laba kotor, tutup & kunci", () => {
  test.afterEach(async ({ browser }, info) => attachAllPages(browser, info));

  test("P-07 US-M11-02 KP-1 US-M11-03 KP-1 KP-2 KP-6 US-M11-06 KP-1 US-M9-02 KP-1 KP-2 US-M11-10 KP-1 KP-2 tutup buku bulan berjalan ujung ke ujung", async ({ browser }, info) => {
    const today = wibDate(0);
    const period = today.slice(0, 7);
    const closeDay = firstOfNextMonth(today);

    const fa = await officeSession(browser, info, "keuangan1");
    const owner = await officeSession(browser, info, "pemilik");

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 1: jurnal otomatis dari transaksi skenario (tidak dicatat ulang)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Jurnal otomatis: pendapatan air truk, piutang, dan selisih kas D01 (P-06) ada di buku besar periode", async () => {
      await fa.page.goto(`/akuntansi/jurnal?periode=${period}&jenis=auto`);
      await expect(fa.page.getByTestId("tabel-jurnal")).toContainText("JD-");
      await fa.page.goto(`/akuntansi/buku-besar?akun=${account("6-1601")}&dari=${period}`);
      await expect(fa.page.getByTestId("tabel-buku-besar")).toContainText("50.000");
      await fa.page.goto(`/akuntansi/buku-besar?akun=${account("4-1101")}&dari=${period}`);
      await expect(fa.page.getByTestId("tabel-buku-besar").getByRole("link", { name: /^J/ }).first()).toBeVisible();
      await fa.page.goto(`/akuntansi/buku-besar?akun=${account("1-1401")}&dari=${period}`);
      await expect(fa.page.getByTestId("tabel-buku-besar").getByRole("link", { name: /^J/ }).first()).toBeVisible();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 2–3: jurnal akrual manual > PAR-20 berlampiran → persetujuan pemilik → terposting → tinjauan pemilik
    // -----------------------------------------------------------------------------------------------------------------
    let journalUrl = "";
    let journalNo = "";
    await test.step("Jurnal akrual gaji Rp 6.500.000 (> PAR-20) diajukan → pemilik menyetujui → terposting", async () => {
      await fa.page.goto("/akuntansi/jurnal/baru");
      const form = fa.page.getByTestId("form-jurnal-manual");
      await form.getByLabel("Keterangan").fill(`Akrual gaji & upah ${period} belum dibayar (skenario P-07)`);
      await form.getByLabel("Akun baris 1").selectOption(account("6-1101"));
      await form.getByLabel("Debit baris 1").fill(String(ACCRUAL));
      await form.getByLabel("Akun baris 2").selectOption(account("2-1401"));
      await form.getByLabel("Kredit baris 2").fill(String(ACCRUAL));
      await form.getByLabel("Jurnal akrual").check();
      await form.getByLabel("Lampiran bukti (foto/PDF)").setInputFiles({ name: "rekap-gaji.pdf", mimeType: "application/pdf", buffer: PDF });
      await form.getByRole("button", { name: "Simpan", exact: true }).click();
      await expect(fa.page).toHaveURL(/\/akuntansi\/jurnal\/[0-9a-f-]{36}$/);
      journalUrl = new URL(fa.page.url()).pathname;
      journalNo = /Jurnal (\S+)/.exec((await fa.page.getByRole("heading", { level: 1 }).textContent()) ?? "")![1]!;
      await expect(fa.page.getByText("Diajukan").first()).toBeVisible();

      expect(await approveAll(owner.page, "Jurnal manual", /6\.500\.000/)).toBeGreaterThanOrEqual(1);
      // Jurnal manual lain yang masih menunggu di periode ini (data demo) diputuskan pemilik juga (prasyarat tutup).
      await approveAll(owner.page, "Jurnal manual");
      await fa.page.goto(journalUrl);
      await expect(fa.page.getByText("Terposting").first()).toBeVisible();
      await expect(fa.page.getByTestId("baris-jurnal")).toContainText("(seimbang)");
    });

    await test.step("Pemilik menandai daftar tinjauan jurnal manual ≤ PAR-20 periode 'ditinjau' (US-M11-03 KP-2)", async () => {
      await owner.page.goto(`/akuntansi/jurnal?tinjauan=${period}`);
      const table = owner.page.getByTestId("tabel-tinjauan");
      // Jurnal > PAR-20 sudah diputuskan pemilik lewat persetujuan → tidak masuk daftar tinjauan (hanya jurnal ≤ PAR-20).
      await expect(table.or(owner.page.getByText(/Tidak ada jurnal/).first())).toBeVisible();
      await expect(owner.page.getByTestId("tabel-tinjauan").getByText(journalNo)).toHaveCount(0);
      const mark = owner.page.getByTestId("tandai-ditinjau");
      if (await mark.isVisible()) {
        await mark.click();
        await expect(table).not.toContainText("Belum");
      }
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 4: rekonsiliasi bank (saldo rekening koran = saldo buku + item otomatis) & kas → nol selisih
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Rekonsiliasi bank & kas periode → nol selisih", async () => {
      // Transfer periode yang masih terbuka (termasuk "Tidak ditemukan" yang menghalangi) dicocokkan dengan mutasi dulu.
      await matchOpenTransfers(fa.page, { from: addDays(`${period}-01`, -90), to: today, note: "rekening koran akhir bulan, skenario P-07" });
      await fa.page.goto(`/akuntansi/rekonsiliasi?periode=${period}`);
      await expect(fa.page.getByRole("heading", { level: 1, name: "Rekonsiliasi bank & kas" })).toBeVisible();
      const banks = fa.page.locator("[data-testid^='rek-bank-']");
      for (let i = 0; i < (await banks.count()); i++) {
        const bank = banks.nth(i);
        if (await bank.getByText("Tidak wajib (tanpa mutasi)").isVisible()) continue;
        const summary = (await bank.locator("p.text-sm").first().textContent()) ?? "";
        const m = /Saldo buku\s*(-?\s?Rp\s?[\d.]+)\s*·\s*item otomatis\s*(-?\s?Rp\s?[\d.]+)/.exec(summary);
        expect(m, summary).toBeTruthy();
        const statement = signedRupiah(m![1]!) + signedRupiah(m![2]!);
        await bank.getByLabel("Saldo rekening koran (Rp)").fill(String(statement));
        await bank.getByRole("button", { name: "Simpan rekonsiliasi bank" }).click();
        await expect(bank).toContainText(/Nol selisih/i);
      }
      const cashRows = fa.page.getByTestId("tabel-rek-kas").locator("tbody tr");
      for (let i = 0; i < (await cashRows.count()); i++) {
        const row = cashRows.nth(i);
        const system = signedRupiah((await row.getByRole("cell").nth(1).textContent()) ?? "");
        await row.getByLabel("Saldo fisik (Rp)").fill(String(system));
        await row.getByRole("button", { name: "Simpan" }).click();
        await expect(row).toContainText(/Nol selisih/i);
      }
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 5: laba kotor per lini "Sementara" sebelum periode dikunci
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Laba kotor bulanan per lini berstatus 'Sementara'", async () => {
      await owner.page.goto(`/laporan/bulanan?bulan=${period}`);
      await expect(owner.page.getByTestId("monthly-status")).toContainText("Sementara");
      const lines = owner.page.getByTestId("monthly-lines");
      for (const line of ["L2", "L3", "L4"]) await expect(lines.getByRole("row").filter({ hasText: line }).first()).toBeVisible();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 6: tanggal 1 bulan berikutnya — Admin Keuangan menutup periode → pemilik mengunci → "Final"
    // -----------------------------------------------------------------------------------------------------------------
    await test.step(`Tanggal ${closeDay}: prasyarat terpenuhi → Admin Keuangan menutup periode ${period}`, async () => {
      await setClock(fa.context, info, offsetTo(closeDay, "09:00"));
      await fa.page.goto(`/akuntansi/periode/${period}`);
      const prereq = fa.page.getByTestId("prasyarat-periode");
      await expect(prereq).toBeVisible();
      // Alokasi biaya L1 & bersama (PAR-65) diposting bila diperlukan.
      for (const kind of ["l1_allocation", "shared_costs"]) {
        const post = fa.page.getByTestId(`alokasi-${kind}`);
        if (await post.isVisible()) {
          await post.click();
          await expect(post).toHaveCount(0);
        }
      }
      await fa.page.reload();
      const failing = prereq.locator("li[data-ok='0']");
      const pending = await failing.allTextContents();
      // Penyusutan diposting otomatis saat tutup — satu-satunya prasyarat yang boleh belum terpenuhi.
      expect(pending.filter((t) => !/Penyusutan/.test(t)), pending.join("\n")).toEqual([]);
      await fa.page.getByTestId("tutup-periode").click();
      await expect(fa.page.getByText("Ditutup").first()).toBeVisible();
    });

    await test.step("Pemilik mengunci periode → laporan laba kotor 'Final'", async () => {
      await setClock(owner.context, info, offsetTo(closeDay, "10:00"));
      await owner.page.goto(`/akuntansi/periode/${period}`);
      await owner.page.getByTestId("kunci-periode").click();
      await expect(owner.page.getByText("Dikunci").first()).toBeVisible();
      await owner.page.goto(`/laporan/bulanan?bulan=${period}`);
      await expect(owner.page.getByTestId("monthly-status")).toContainText("Final");
      await expect(owner.page.getByTestId("monthly-status")).toHaveAttribute("data-status", /final/i);
    });

    await test.step(`Tanggal ${closeDay} 00.30: jurnal akrual dibalik otomatis di periode berikutnya (US-M11-03 KP-6)`, async () => {
      const ran = await cronTick(fa.page, { only: ["m11.accrual.reverse"], now: wibInstant(closeDay, "00:35") });
      expect(ran.find((r) => r.key === "m11.accrual.reverse")?.status).toBe("succeeded");
      await fa.page.goto(`/akuntansi/jurnal?periode=${closeDay.slice(0, 7)}&jenis=accrual_reversal`);
      const row = fa.page.getByTestId("tabel-jurnal").getByRole("row").filter({ hasText: `Pembalik otomatis akrual ${journalNo}` });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("6.500.000");
    });

    await fa.context.close();
    await owner.context.close();
  });
});
