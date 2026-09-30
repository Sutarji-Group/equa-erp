import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

import {
  activateField,
  attachAllPages,
  digits,
  issueActivationCode,
  matchOpenTransfers,
  officeSession,
  rp,
  waitSynced,
  wibDate,
} from "./helpers";

/**
 * P-06 — Tutup kas harian (BRD Bab 5; PRD US-M4-01..06, US-M9-01, KPI-02, NFR-04).
 *
 * Depot D01 Pasir Hayam (tablet POS-D01, operator Euis Komariah) menjual tunai & QRIS lalu menutup shift dan menyerahkan
 * setoran → Admin Keuangan: (1) menerima SEMUA setoran hari itu (setoran D01 kurang Rp 50.000 = PAR-01 → beralasan →
 * diteruskan ke pemilik), sumber yang berhalangan (sopir belum setor / shift masih buka) diajukan PENGECUALIAN per
 * kejadian yang disetujui pemilik (PTB-21); (2) mencocokkan transfer (termasuk QRIS shift D01) dengan mutasi;
 * (3) memulai & menutup kas (hitung fisik kas kantor) → (4) H+0 terbit ≤ 30 menit → pemilik (ponsel) menyetujui selisih
 * satu ketuk dari ringkasan H+0.
 *
 * Skenario ini berjalan di atas keadaan apa pun yang ditinggalkan uji sebelumnya (hari kas sebelumnya yang belum ditutup
 * ditutup lebih dulu — BR-14 berurutan), sehingga penghalang diselesaikan secara umum, bukan dari daftar tetap.
 */
const SHORTFALL = 50_000;

type Blocker = { kind: string; source: string; href: string | null; exception: string; canRequest: boolean };

async function readBlockers(page: Page): Promise<Blocker[]> {
  const table = page.getByTestId("penghalang-tutup-kas");
  if (!(await table.isVisible())) return [];
  const rows = table.locator("tbody tr");
  const out: Blocker[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const cells = rows.nth(i).getByRole("cell");
    const link = cells.nth(1).getByRole("link");
    out.push({
      kind: ((await cells.nth(0).textContent()) ?? "").trim(),
      source: ((await cells.nth(1).textContent()) ?? "").trim(),
      href: (await link.count()) ? await link.first().getAttribute("href") : null,
      exception: ((await cells.nth(3).textContent()) ?? "").trim(),
      canRequest: (await cells.nth(3).getByRole("button", { name: "Ajukan pengecualian" }).count()) > 0,
    });
  }
  return out;
}

/** Terima satu setoran di rincian setoran (dihitung sistem); `short` = kurang diterima (beralasan). */
async function receiveDeposit(page: Page, href: string, short = 0): Promise<number> {
  await page.goto(href);
  const form = page.getByTestId("form-terima-setoran");
  await expect(form).toBeVisible();
  // Pengeluaran rit menunggu verifikasi (PTB-20) diterima.
  const accept = form.getByRole("radio", { name: "Terima" });
  for (let i = 0; i < (await accept.count()); i++) await accept.nth(i).check();
  const calc = form.getByTestId("hitung-selisih");
  const expected = Number(await calc.getAttribute("data-expected-net"));
  await form.getByLabel("Jumlah fisik diterima (Rp)").fill(String(expected - short));
  if (short) {
    await expect(calc).toContainText(new RegExp(`-${rp(short).source}`));
    await expect(calc).toContainText("diteruskan ke pemilik");
    await form.locator("select[name='discrepancyReason']").selectOption({ label: "Salah kembalian" });
    await form.locator("input[name='discrepancyNote']").fill("Operator salah memberi kembalian dua pelanggan galon baru (skenario P-06)");
  } else {
    await expect(calc).toContainText("Rp 0");
  }
  const late = form.locator("input[name='lateReason']");
  if (await late.isVisible()) await late.fill("Setoran diterima setelah jam batas (skenario P-06)");
  await form.getByRole("button", { name: "Terima setoran" }).click();
  await expect(page.getByText("Hasil penerimaan")).toBeVisible();
  return expected;
}

/** Pemilik menyetujui semua pengecualian tutup kas yang menunggu (per kejadian, 6.2a). */
async function approveExceptions(browser: Browser, info: TestInfo): Promise<void> {
  const owner = await officeSession(browser, info, "pemilik", "phone");
  for (let n = 0; n < 12; n++) {
    await owner.page.goto("/persetujuan");
    const item = owner.page.locator("li").filter({ hasText: "Tutup kas dengan setoran tertunda" }).first();
    if (!(await item.isVisible())) break;
    await item.getByRole("button", { name: "Setujui" }).click();
    await expect(owner.page.getByText(/Permintaan A-\d{2}-\d+ disetujui/).first()).toBeVisible();
  }
  await owner.context.close();
}

/**
 * Tutup kas tanggal `date` (US-M4-06): setoran Diajukan diterima, sumber berhalangan diajukan pengecualian → pemilik
 * menyetujui, hari sebelumnya ditutup lebih dulu (rekursif). `before` dijalankan setelah penghalang beres, sebelum Tutup.
 */
async function closeCashDay(
  browser: Browser,
  info: TestInfo,
  page: Page,
  date: string,
  opts: { shortDeposit?: RegExp; before?: () => Promise<void> } = {},
  depth = 0,
): Promise<void> {
  expect(depth, "rantai hari kas terlalu panjang").toBeLessThan(15);
  for (let round = 0; round < 6; round++) {
    await page.goto(`/kas/tutup?tanggal=${date}`);
    await expect(page.getByRole("heading", { level: 1, name: "Tutup kas" })).toBeVisible();
    if (!(await page.getByTestId("form-tutup-kas").isVisible()) && (await page.getByText("Kas kantor saat tutup").isVisible())) return;
    const blockers = await readBlockers(page);
    // Sudah tercakup pengecualian yang disetujui / kasnya diterima → bukan penghalang lagi.
    const open = blockers.filter((b) => !/Disetujui|Kas diterima/.test(b.exception));
    if (open.length === 0) break;
    let requested = open.some((b) => /Diajukan/.test(b.exception));
    for (const b of open.filter((x) => !/Diajukan/.test(x.exception))) {
      if (b.href?.startsWith("/kas/tutup")) {
        await closeCashDay(browser, info, page, new URL(b.href, "http://x").searchParams.get("tanggal")!, {}, depth + 1);
        continue;
      }
      // Setoran yang sudah diserahkan (Diajukan) diterima; yang masih Berjalan (belum diserahkan) → pengecualian.
      if (b.href?.startsWith("/kas/setoran/") && !b.source.includes("Berjalan")) {
        await page.goto(b.href);
        if (await page.getByTestId("form-terima-setoran").isVisible()) {
          await receiveDeposit(page, b.href, opts.shortDeposit?.test(b.source) ? SHORTFALL : 0);
          continue;
        }
      }
      if (b.canRequest) {
        await page.goto(`/kas/tutup?tanggal=${date}`);
        const row = page.getByTestId("penghalang-tutup-kas").locator("tbody tr").filter({ hasText: b.source }).first();
        await row.getByRole("button", { name: "Ajukan pengecualian" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("Alasan").fill(`Sumber berhalangan menyetor hari ini — kas diterima besok (skenario P-06): ${b.source}`);
        await dialog.getByRole("button", { name: "Ajukan pengecualian" }).click();
        await expect(dialog).toHaveCount(0);
        requested = true;
      } else {
        throw new Error(`Penghalang tutup kas ${date} tidak dapat diselesaikan otomatis: ${b.kind} — ${b.source}`);
      }
    }
    if (requested) await approveExceptions(browser, info);
  }
  await page.goto(`/kas/tutup?tanggal=${date}`);
  await expect(page.getByText(/Tidak ada penghalang|Semua sumber sudah beres/).first()).toBeVisible();
  if (opts.before) {
    await opts.before();
    await page.goto(`/kas/tutup?tanggal=${date}`);
  }
  const start = page.getByTestId("mulai-tutup-kas");
  if (await start.isEnabled().catch(() => false)) {
    await start.click();
    await expect(start).toBeDisabled();
  }
  const system = Number(await page.getByTestId("isian-tutup-kas").getAttribute("data-system-amount"));
  const close = page.getByTestId("form-tutup-kas");
  await close.getByLabel("Hitung fisik kas kantor (Rp)").fill(String(system));
  await close.getByRole("button", { name: "Tutup kas" }).click();
  await expect(page.getByText("Kas kantor saat tutup")).toBeVisible();
}

test.describe("P-06 tutup kas harian — setoran, transfer, selisih, tutup, H+0, keputusan pemilik", () => {
  test.afterEach(async ({ browser }, info) => attachAllPages(browser, info));

  test("P-06 US-M4-02 KP-1 KP-2 KP-7 US-M4-04 KP-1 KP-2 US-M4-06 KP-1 KP-2 KP-3 KP-4 KP-5 KP-6 US-M4-03 KP-2 US-M9-01 KP-2 KP-4 depot D01 & tutup kas hari ini ujung ke ujung", async ({ browser }, info) => {
    const today = wibDate(0);

    // -----------------------------------------------------------------------------------------------------------------
    // Depot D01: shift → 2 galon baru + isi (tunai) & 1 isi ulang QRIS → tutup shift → serah setoran Rp 90.000
    // -----------------------------------------------------------------------------------------------------------------
    const admin = await officeSession(browser, info, "admin1");
    const posCode = await issueActivationCode(admin.page, "POS-D01", "Tablet POS D01 dipasang ulang (skenario P-06)");
    await admin.context.close();
    const pos = await activateField(browser, info, { code: posCode, kind: "tablet", app: "/pos", user: /Euis Komariah/ });
    const p = pos.page;
    let handed = 0;
    await test.step("Operator D01: buka shift, jual tunai & QRIS, tutup shift, serahkan setoran", async () => {
      const open = p.getByTestId("buka-shift");
      await expect(open).toBeVisible({ timeout: 30_000 });
      await open.getByRole("button", { name: "Buka shift" }).click();
      await waitSynced(p);
      const newGallon = p.getByRole("button", { name: /^Galon baru \+ isi 19 L, Rp\s?45\.000/ });
      await newGallon.click();
      await newGallon.click();
      await p.getByRole("button", { name: "Simpan · Tunai" }).click();
      await expect(p.getByTestId("struk")).toContainText(rp(90_000));
      await p.getByRole("button", { name: "Transaksi baru" }).click();
      await p.getByRole("button", { name: /^Isi ulang galon 19 L, Rp\s?5\.000/ }).click();
      await p.getByRole("radio", { name: "QRIS" }).click();
      await p.getByRole("button", { name: "QRIS diterima · Simpan" }).click();
      await expect(p.getByTestId("struk")).toContainText(rp(5_000));
      await p.getByRole("button", { name: "Transaksi baru" }).click();
      await waitSynced(p);

      await p.getByRole("navigation", { name: "Menu POS" }).getByRole("button", { name: "Shift & void" }).click();
      const close = p.getByTestId("tutup-shift");
      const expected = digits(await close.getByTestId("tunai-seharusnya").textContent());
      expect(expected).toBe(290_000);
      await close.getByLabel("Kas fisik di laci (hitung)").fill(String(expected));
      for (const name of ["Tutup galon", "Tisu segel galon", "Galon kosong 19 L (bahan)"]) {
        const label = close.locator("label", { hasText: `${name} (fisik)` });
        const should = Number(/stok seharusnya (-?\d+)/.exec((await label.textContent()) ?? "")?.[1] ?? "0");
        await label.locator("input").fill(String(Math.max(0, should)));
      }
      const reasons = close.getByRole("textbox", { name: /^Alasan selisih [+-]?\d/ });
      for (let i = 0; i < (await reasons.count()); i++) await reasons.nth(i).fill("Hitung fisik akhir shift (skenario P-06)");
      await close.getByRole("button", { name: "Tutup shift" }).click();
      const handover = p.getByTestId("serah-setoran");
      await expect(handover).toBeVisible({ timeout: 30_000 });
      handed = expected - 200_000;
      await expect(handover).toContainText(rp(handed));
      await handover.getByRole("button", { name: "Tandai sudah disetor" }).click();
      await expect(handover).toContainText("Setoran ditandai Disetor");
      await waitSynced(p);
      await pos.context.close();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 1–3: posisi kas → terima semua setoran (selisih ≥ PAR-01 ke pemilik) → cocokkan transfer → tutup kas
    // -----------------------------------------------------------------------------------------------------------------
    const fa = await officeSession(browser, info, "keuangan1");
    await test.step("Admin Keuangan: posisi kas hari ini per sumber (US-M4-01) menampilkan D01", async () => {
      await fa.page.goto(`/kas?tanggal=${today}`);
      await expect(fa.page.getByRole("heading", { level: 1, name: "Kas hari ini" })).toBeVisible();
      await expect(fa.page.getByTestId("kas-depot")).toContainText("D01");
    });

    await test.step("Tutup kas: setoran diterima (D01 kurang Rp 50.000 beralasan), pengecualian disetujui pemilik, transfer dicocokkan", async () => {
      await closeCashDay(browser, info, fa.page, today, {
        shortDeposit: /D01/,
        before: async () => {
          // US-M9-01 KP-2: sebelum tutup kas, H+0 berupa angka berjalan berlabel "belum ditutup".
          await fa.page.goto(`/laporan/hari-ini?tanggal=${today}`);
          await expect(fa.page.getByTestId("h0-status")).toContainText("Belum ditutup — angka dapat berubah");
          await fa.page.goto(`/kas/tutup?tanggal=${today}`);
          // Selisih hari ini tampil di layar tutup kas (KP-3), termasuk selisih D01 yang diteruskan ke pemilik.
          const disc = fa.page.getByTestId("selisih-hari-ini").getByRole("row").filter({ hasText: "Shift depot" }).filter({ hasText: /-Rp\s?50\.000/ });
          await expect(disc).toContainText("Salah kembalian");
          // D-12 butir 7: tiap baris menyebut outlet/truk & nama karyawan, bukan hanya jenis sumber.
          await expect(disc.getByTestId("selisih-sumber")).toContainText("D01");
          await expect(disc.getByTestId("selisih-sumber")).toContainText("·");
          // Langkah 2: cocokkan transfer terbuka (QRIS shift D01, transfer rit, pelunasan) dengan mutasi internet banking.
          await fa.page.goto(`/kas/transfer?dari=${today}&sampai=${today}`);
          const qris = fa.page.getByTestId("daftar-transfer").getByRole("row").filter({ hasText: "QRIS shift" }).filter({ hasText: "D01" });
          await expect(qris).toHaveCount(1);
          await expect(qris).toContainText(rp(5_000));
          expect(await matchOpenTransfers(fa.page, { from: today, to: today, note: "skenario P-06" })).toBeGreaterThanOrEqual(1);
          // Transfer yang sudah cocok pindah ke saringan "Cocok" beserta referensi mutasinya.
          await fa.page.goto(`/kas/transfer?status=matched&dari=${today}&sampai=${today}`);
          await expect(qris).toContainText("Cocok");
          await expect(qris).toContainText("TRSF E-BANKING CR");
        },
      });
      await expect(fa.page.getByTestId("riwayat-hari-kas").getByRole("row").nth(1)).toContainText("Ditutup");
      await expect(fa.page.getByTestId("form-tutup-kas")).toHaveCount(0);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 4: H+0 terbit ≤ 30 menit setelah kas ditutup (NFR-04) → pemilik menyetujui selisih dari ringkasan
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("H+0 terbit ≤ 30 menit setelah kas ditutup; pemilik (ponsel) menyetujui selisih D01 satu ketuk", async () => {
      await fa.page.goto(`/laporan/hari-ini?tanggal=${today}`);
      const status = fa.page.getByTestId("h0-status");
      await expect(status).toContainText("H+0 terbit");
      const minutes = Number(/\((\d+) menit\)/.exec((await status.textContent()) ?? "")?.[1] ?? "999");
      expect(minutes).toBeLessThanOrEqual(30);
      await fa.context.close();

      const owner = await officeSession(browser, info, "pemilik", "phone");
      await owner.page.goto("/laporan/hari-ini");
      const pending = owner.page.getByTestId("h0-pending-discrepancy").filter({ hasText: "D01" });
      await expect(pending).toHaveCount(1);
      await expect(pending).toContainText(/-Rp\s?50\.000/);
      await expect(pending).toContainText("salah memberi kembalian");
      await pending.getByTestId("h0-approve").click();
      await expect(owner.page.getByTestId("h0-pending-discrepancy").filter({ hasText: "D01" })).toHaveCount(0);
      await owner.page.goto("/kas/selisih?tampil=semua");
      await expect(owner.page.getByTestId("daftar-selisih").getByRole("row").filter({ hasText: "D01" }).first()).toContainText("Selesai");
      await owner.context.close();
    });
    expect(handed).toBe(90_000);
  });
});
