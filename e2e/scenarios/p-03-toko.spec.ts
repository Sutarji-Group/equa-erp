import { expect, test, type Page } from "@playwright/test";

import { activateField, attachAllPages, digits, issueActivationCode, officeSession, PHOTO, rp, waitSynced } from "./helpers";

/**
 * P-03 — Toko (BRD Bab 5; PRD US-M7-01, US-M7-02, US-M7-04, US-M7-05, US-M7-06, US-M7-09).
 *
 * Toko TK1 (tablet POS-TK1, kasir Fitri Handayani): buka shift → penerimaan barang dari nota pemasok (+foto) → jual harga
 * mitra, harga umum, dan tempo mitra → opname bulanan (hitung buta) → Admin Keuangan mengajukan penyesuaian → pemilik
 * menyetujui → transfer internal bahan ke depot D05 → operator depot D05 menerima di POS depot → tutup shift & setoran.
 */
const NOTE_NO = `NP-P03-${Date.now() % 1_000_000}`;

async function addProduct(page: Page, query: string, name: RegExp): Promise<void> {
  await page.getByLabel("Cari barang (nama, kode, barcode)").fill(query);
  await page.getByTestId("hasil-cari").getByRole("button", { name }).click();
}

test.describe("P-03 toko — penerimaan, penjualan mitra/umum/tempo, opname, transfer internal", () => {
  test.afterEach(async ({ browser }, info) => attachAllPages(browser, info));

  test("P-03 US-M7-02 KP-1 US-M7-01 KP-1 KP-2 KP-3 US-M7-04 KP-2 US-M7-05 KP-1 KP-2 US-M7-06 KP-1 US-M7-09 KP-1 KP-2 toko TK1 ujung ke ujung", async ({ browser }, info) => {
    const admin = await officeSession(browser, info, "admin1");
    const storeCode = await issueActivationCode(admin.page, "POS-TK1", "Tablet POS toko dipasang ulang (skenario P-03)");
    const depotCode = await issueActivationCode(admin.page, "POS-D05", "Tablet POS D05 dipasang ulang (skenario P-03)");
    await admin.context.close();

    const store = await activateField(browser, info, { code: storeCode, kind: "tablet", app: "/pos", user: /Fitri Handayani/ });
    const s = store.page;
    const menu = s.getByRole("navigation", { name: "Menu POS toko" });
    await expect(menu).toBeVisible({ timeout: 30_000 });
    await test.step("Kasir membuka shift toko", async () => {
      const open = s.getByTestId("buka-shift");
      await expect(open).toBeVisible({ timeout: 30_000 });
      await open.getByRole("button", { name: "Buka shift" }).click();
      await expect(s.getByTestId("pilih-pelanggan")).toBeVisible({ timeout: 30_000 });
      await waitSynced(s);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 1: penerimaan barang dari nota pemasok (BR-28: nota + foto wajib) → stok & utang pemasok
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Penerimaan 200 tutup galon dari nota pemasok (US-M7-02 KP-1)", async () => {
      await menu.getByRole("button", { name: "Terima barang" }).click();
      const form = s.getByTestId("terima-barang");
      await expect(form).toBeVisible();
      await form.getByRole("radio", { name: "Ada nota pemasok" }).click();
      await form.getByLabel("Pemasok", { exact: true }).selectOption({ label: "CV Sumber Plastik Cianjur" });
      await form.getByLabel("Nomor nota pemasok").fill(NOTE_NO);
      await form.getByLabel("Foto nota pemasok", { exact: true }).setInputFiles({ name: "nota.png", mimeType: "image/png", buffer: PHOTO });
      await expect(s.getByText(/Foto tersimpan/).first()).toBeVisible();
      await s.getByLabel("Cari barang untuk nota").fill("tutup");
      await s.getByRole("button", { name: /Tutup galon/ }).first().click();
      await s.getByLabel(/^Jumlah \(pcs\)/).fill("200");
      await s.getByLabel("Harga beli satuan").fill("450");
      await s.getByRole("button", { name: "Tambah ke nota" }).click();
      await expect(s.getByTestId("baris-nota")).toContainText(rp(90_000));
      await s.getByLabel("Total tertulis di nota").fill("90000");
      await s.getByTestId("simpan-penerimaan").click();
      await expect(s.getByText(/tersimpan|tercatat/i).first()).toBeVisible();
      await waitSynced(s);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 2: jual harga mitra, harga umum, tempo mitra (BR-17/18, US-M7-04)
    // -----------------------------------------------------------------------------------------------------------------
    let cashSales = 0;
    await test.step("Jual harga mitra, harga umum, dan tempo mitra", async () => {
      await menu.getByRole("button", { name: "Jual" }).click();
      await s.getByLabel("Pelanggan").selectOption({ label: "Depot Barokah Cilaku — mitra toko" });
      await expect(s.getByTestId("jenis-harga")).toContainText("Harga mitra");
      for (let i = 0; i < 5; i++) await addProduct(s, "tutup", /Tutup galon/);
      await expect(s.getByTestId("total-toko")).toContainText(rp(3_000));
      await s.getByTestId("simpan-transaksi-toko").click();
      await expect(s.getByTestId("struk-toko")).toContainText(rp(3_000));
      await s.getByRole("button", { name: "Transaksi baru" }).click();
      cashSales += 3_000;

      // Penjualan umum TANPA SINYAL dengan diskon 5% beralasan (batas kasir PAR-14/BR-17) → tersimpan di tablet, terkirim
      // otomatis saat sinyal kembali.
      await store.context.setOffline(true);
      await expect(s.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
      await s.getByLabel("Pelanggan").selectOption({ label: "Umum (harga umum, tunai/QRIS)" });
      await expect(s.getByTestId("jenis-harga")).toContainText("Harga umum");
      await addProduct(s, "sikat", /Sikat galon/);
      await s.getByLabel("Diskon per transaksi (Rp)").fill("1000");
      await s.getByLabel("Alasan diskon").fill("Pelanggan langganan beli rutin (skenario P-03)");
      await expect(s.getByText("Diskon di atas batas")).toHaveCount(0);
      await expect(s.getByTestId("total-toko")).toContainText(rp(19_000));
      await s.getByTestId("simpan-transaksi-toko").click();
      await expect(s.getByTestId("struk-toko")).toContainText(rp(19_000));
      await expect(s.getByTestId("struk-toko")).toContainText("Diskon");
      await s.getByRole("button", { name: "Transaksi baru" }).click();
      await expect(s.getByText(/Tersimpan di ponsel: \d+/).first()).toBeVisible();
      await store.context.setOffline(false);
      await waitSynced(s);
      cashSales += 19_000;

      await s.getByLabel("Pelanggan").selectOption({ label: "Depot Air Tirta Sari — mitra toko" });
      await addProduct(s, "sabun", /Sabun cuci galon/);
      await s.getByRole("radio", { name: "Tempo mitra" }).click();
      await expect(s.getByText(/Sisa batas kredit/)).toBeVisible();
      await s.getByTestId("simpan-transaksi-toko").click();
      await expect(s.getByTestId("faktur-tempo")).toBeVisible();
      await s.getByRole("button", { name: "Transaksi baru" }).click();
      await waitSynced(s);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 3: opname bulanan (hitung buta) → Admin Keuangan mengajukan penyesuaian → pemilik menyetujui
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Opname bulanan: hitung buta, selisih −2 tisu segel", async () => {
      await menu.getByRole("button", { name: "Stok & opname" }).click();
      await s.getByRole("radio", { name: "Opname" }).click();
      const sheet = s.getByTestId("opname-toko");
      await expect(sheet).toBeVisible();
      // Hitung buta: saldo sistem baru tampil setelah jumlah fisik diisi.
      const count = async (code: string, name: string, delta: number) => {
        const row = sheet.locator("li").filter({ hasText: name }).first();
        await expect(row.getByTestId(`hasil-hitung-${code}`)).toContainText("Saldo tampil setelah dihitung");
        await row.getByLabel("Jumlah fisik").fill("0");
        const system = Number(/Sistem (-?\d+)/.exec((await row.getByTestId(`hasil-hitung-${code}`).textContent()) ?? "")?.[1]);
        expect(Number.isFinite(system)).toBe(true);
        await row.getByLabel("Jumlah fisik").fill(String(system + delta));
        await expect(row.getByTestId(`hasil-hitung-${code}`)).toContainText(`selisih ${delta > 0 ? `+${delta}` : delta}`);
      };
      await count("TK-TISU", "Tisu segel galon", -2);
      await count("TK-SIKAT", "Sikat galon", 0);
      await count("TK-POMPA", "Pompa galon manual", 0);
      // US-M7-05 KP-1 / BR-27: opname wajib mencakup SELURUH barang toko — sisa barang dihitung tanpa selisih
      // (opname sebagian ditolak saat diajukan Admin Keuangan).
      const rows = sheet.locator("li");
      const total = await rows.count();
      for (let i = 0; i < total; i++) {
        const row = rows.nth(i);
        const result = row.locator('[data-testid^="hasil-hitung-"]');
        if (!((await result.textContent()) ?? "").includes("Saldo tampil setelah dihitung")) continue;
        await row.getByLabel("Jumlah fisik").fill("0");
        await expect(result).toContainText("Sistem");
        const system = Number(/Sistem (-?\d+)/.exec((await result.textContent()) ?? "")?.[1]);
        expect(Number.isFinite(system)).toBe(true);
        await row.getByLabel("Jumlah fisik").fill(String(system));
        await expect(result).toContainText("selisih 0");
      }
      await sheet.getByRole("button", { name: "Simpan hitungan" }).click();
      await expect(sheet.getByText(/Hitungan tersimpan/)).toBeVisible();
      await waitSynced(s);
    });

    await test.step("Admin Keuangan mengajukan penyesuaian opname → pemilik menyetujui (US-M7-05 KP-2)", async () => {
      const fa = await officeSession(browser, info, "keuangan1");
      await fa.page.goto("/toko/opname");
      const month = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
      await fa.page.getByRole("link", { name: new RegExp(month) }).first().click();
      await expect(fa.page).toHaveURL(/\/toko\/opname\/[0-9a-f-]{36}$/);
      const form = fa.page.getByTestId("form-ajukan-opname");
      for (const select of await form.locator("select[name^='reason_']").all()) await select.selectOption({ index: 1 });
      await form.getByRole("button", { name: "Ajukan ke pemilik" }).click();
      await expect(fa.page.getByText(/diajukan|Menunggu/).first()).toBeVisible();
      await fa.context.close();

      const owner = await officeSession(browser, info, "pemilik");
      await owner.page.goto("/persetujuan");
      const card = owner.page.locator("li").filter({ hasText: /opname|stok/i }).filter({ hasText: /TK1|Toko/ }).first();
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Setujui" }).click();
      await expect(owner.page.getByText(/Permintaan A-\d{2}-\d+ disetujui/)).toBeVisible();
      await owner.context.close();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 4: transfer internal toko → depot D05, diterima di POS depot (US-M7-06)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Transfer internal 50 tutup galon ke D05 → operator D05 menerima", async () => {
      await menu.getByRole("button", { name: "Stok & opname" }).click();
      await s.getByRole("radio", { name: "Transfer ke depot" }).click();
      const form = s.getByTestId("transfer-internal");
      await form.getByLabel("Depot tujuan").selectOption({ label: "D05 · Depot EQUA Warungkondang" });
      await form.getByLabel(/^Tutup galon \(stok/).fill("50");
      await form.getByRole("button", { name: "Kirim ke depot" }).click();
      await expect(s.getByText(/Transfer tercatat/)).toBeVisible();
      await waitSynced(s);

      const depot = await activateField(browser, info, { code: depotCode, kind: "tablet", app: "/pos", user: /Wawan Gunawan/ });
      const p = depot.page;
      const depotMenu = p.getByRole("navigation", { name: "Menu POS" });
      await expect(depotMenu).toBeVisible({ timeout: 30_000 });
      await depotMenu.getByRole("button", { name: "Stok bahan" }).click();
      const item = p.locator("li").filter({ hasText: /Transfer .* dari Toko EQUA Cianjur/ }).first();
      await expect(item).toBeVisible({ timeout: 45_000 });
      await expect(item.getByLabel(/Tutup galon \(dikirim 50/)).toHaveValue(/50/);
      await item.getByRole("button", { name: "Terima transfer" }).click();
      await waitSynced(p);
      await depot.context.close();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Tutup shift toko (US-M7-09): kas fisik = tunai seharusnya (tempo tidak masuk laci) → serah setoran
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Tutup shift toko & serah setoran", async () => {
      await menu.getByRole("button", { name: "Shift & kas" }).click();
      const close = s.getByTestId("tutup-shift");
      const expected = digits(await close.getByTestId("tunai-seharusnya").textContent());
      expect(expected).toBe(200_000 + cashSales);
      await close.getByLabel("Kas fisik di laci (hitung)").fill(String(expected));
      await close.getByRole("button", { name: "Tutup shift" }).click();
      const handover = s.getByTestId("serah-setoran");
      await expect(handover).toBeVisible({ timeout: 30_000 });
      await expect(handover).toContainText(rp(cashSales));
      await waitSynced(s);
      await handover.getByRole("button", { name: "Tandai sudah disetor" }).click();
      await waitSynced(s);
    });
    await store.context.close();
  });
});
