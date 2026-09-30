import { expect, test } from "@playwright/test";

import {
  activateField,
  assignAndPublish,
  attachAllPages,
  createOrder,
  digits,
  issueActivationCode,
  officeSession,
  rp,
  runTripFromDetail,
  syncNow,
  waitSynced,
  wibDate,
} from "./helpers";

/**
 * P-02 — Depot isi ulang (BRD Bab 5; PRD US-M6-01..03, US-M6-05, US-M6-06, US-M4-02 KP-7).
 *
 * Depot D05 Warungkondang (tablet POS-D05, operator Wawan Gunawan): buka shift → jual tunai & QRIS (sebagian TANPA
 * SINYAL) → void ≤ PAR-04 langsung, void > PAR-04 menunggu & disetujui pemilik → pasokan air dari rit internal truk T4
 * (Dispatcher membuat pesanan pasokan depot, sopir Cecep Hidayat menyerahkan) dikonfirmasi → tutup shift dengan hitung
 * fisik kas & bahan → setoran shift diserahkan → Admin Keuangan menerima.
 */
const D05 = { latitude: -6.8756, longitude: 107.1108 };

test.describe("P-02 depot — shift, penjualan, void, pasokan air, tutup shift, setoran", () => {
  test.afterEach(async ({ browser }, info) => attachAllPages(browser, info));

  test("P-02 US-M6-02 KP-1 KP-3 KP-5 US-M6-01 KP-1 KP-2 US-M6-06 KP-1 KP-2 US-M6-03 KP-1 KP-2 US-M6-05 KP-1 US-M4-02 KP-7 depot D05 satu shift ujung ke ujung", async ({ browser }, info) => {
    const today = wibDate(0);

    const admin = await officeSession(browser, info, "admin1");
    const posCode = await issueActivationCode(admin.page, "POS-D05", "Tablet POS D05 dipasang ulang (skenario P-02)");
    const phoneCode = await issueActivationCode(admin.page, "HP-T4", "Ponsel truk T4 dipasang ulang (skenario P-02)");
    await admin.context.close();

    // Pasokan depot: pesanan internal Dispatcher → truk T4 → terbit (PTB-01, US-M8-03).
    const dispatcher = await officeSession(browser, info, "dispatcher1");
    const supplyOrder = await createOrder(dispatcher.page, { internalDepot: "D05", date: today, notes: "Pasokan air depot D05 (skenario P-02)" });
    await assignAndPublish(dispatcher.page, today, [supplyOrder], "T4");
    await dispatcher.context.close();

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 1: buka shift (kas awal tetap PAR-57, stok awal bahan dari sistem)
    // -----------------------------------------------------------------------------------------------------------------
    const pos = await activateField(browser, info, { code: posCode, kind: "tablet", app: "/pos", user: /Wawan Gunawan/ });
    const p = pos.page;
    const menu = p.getByRole("navigation", { name: "Menu POS" });
    await test.step("Operator depot membuka shift", async () => {
      const open = p.getByTestId("buka-shift");
      await expect(open).toBeVisible({ timeout: 30_000 });
      await expect(open).toContainText(rp(200_000));
      await open.getByRole("button", { name: "Buka shift" }).click();
      await waitSynced(p);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 2: jual tunai & QRIS — sebagian tanpa sinyal (US-M6-06)
    // -----------------------------------------------------------------------------------------------------------------
    const refill = p.getByRole("button", { name: /^Isi ulang galon 19 L, Rp\s?5\.000/ });
    const newGallon = p.getByRole("button", { name: /^Galon baru \+ isi 19 L, Rp\s?45\.000/ });
    await test.step("Jual tunai (daring) lalu QRIS & tunai TANPA SINYAL → terkirim otomatis", async () => {
      await refill.click();
      await refill.click();
      await p.getByRole("button", { name: "Simpan · Tunai" }).click();
      await expect(p.getByTestId("struk")).toContainText(rp(10_000));
      await p.getByRole("button", { name: "Transaksi baru" }).click();
      await waitSynced(p);

      await pos.context.setOffline(true);
      await expect(p.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
      await refill.click();
      await p.getByRole("radio", { name: "QRIS" }).click();
      await p.getByRole("button", { name: "QRIS diterima · Simpan" }).click();
      await expect(p.getByTestId("struk")).toContainText("Tersimpan di perangkat");
      await expect(p.getByTestId("nomor-transaksi")).toContainText(/D05-\d{6}-POSD05-\d{4}/);
      await p.getByRole("button", { name: "Transaksi baru" }).click();
      await refill.click();
      await p.getByRole("radio", { name: "Tunai" }).click();
      await p.getByRole("button", { name: "Simpan · Tunai" }).click();
      await expect(p.getByTestId("struk")).toContainText("Tersimpan di perangkat");
      await p.getByRole("button", { name: "Transaksi baru" }).click();
      await expect(p.getByText(/Tersimpan di ponsel: \d+/).first()).toBeVisible();
      await pos.context.setOffline(false);
      await waitSynced(p);

      // Transaksi besar (3 galon baru + isi = Rp 135.000 > PAR-04 Rp 100.000) — nanti di-void dengan persetujuan.
      for (let i = 0; i < 3; i++) await newGallon.click();
      await p.getByRole("button", { name: "Simpan · Tunai" }).click();
      await expect(p.getByTestId("struk")).toContainText(rp(135_000));
      await p.getByRole("button", { name: "Transaksi baru" }).click();
      await waitSynced(p);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 4: void ≤ PAR-04 langsung; void > PAR-04 menunggu persetujuan pemilik (BR-13)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Void kecil langsung; void besar menunggu persetujuan pemilik → disetujui", async () => {
      await menu.getByRole("button", { name: "Shift & void" }).click();
      const sales = p.getByRole("list", { name: "Transaksi shift" });
      const qris = sales.locator("li", { hasText: "QRIS" }).first();
      await qris.getByRole("button", { name: "Void…" }).click();
      await qris.getByRole("radio", { name: "Salah cara bayar" }).click();
      await qris.getByRole("button", { name: "Void transaksi ini" }).click();
      await expect(p.getByText("Transaksi di-void.")).toBeVisible();
      await waitSynced(p);

      const big = sales.locator("li", { hasText: /135\.000/ }).first();
      await big.getByRole("button", { name: "Void…" }).click();
      await expect(big.getByText(/void perlu persetujuan pemilik/)).toBeVisible();
      await big.getByRole("radio", { name: "Pelanggan batal" }).click();
      await big.getByRole("button", { name: "Void transaksi ini" }).click();
      await expect(p.getByText(/Void menunggu persetujuan pemilik/).first()).toBeVisible();
      await waitSynced(p);

      const owner = await officeSession(browser, info, "pemilik", "phone");
      await owner.page.goto("/persetujuan");
      const card = owner.page.locator("li").filter({ hasText: /void/i }).filter({ hasText: /135\.000/ }).first();
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Setujui" }).click();
      await expect(owner.page.getByText(/Permintaan A-\d{2}-\d+ disetujui/)).toBeVisible();
      await owner.context.close();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 3: pasokan air dari rit internal T4 → dikonfirmasi di POS (US-M6-05 KP-1)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Sopir T4 menyerahkan pasokan internal ke D05 → operator mengonfirmasi volume", async () => {
      const driver = await activateField(browser, info, { code: phoneCode, kind: "phone", app: "/sopir", user: /Cecep Hidayat/, geolocation: D05 });
      const d = driver.page;
      await expect(d.getByRole("region", { name: "Rit hari ini" }).getByTestId(`rit-${supplyOrder}/1`)).toBeVisible({ timeout: 30_000 });
      await runTripFromDetail(d, { tripNo: `${supplyOrder}/1`, point: D05, internal: true });
      await expect(d.getByTestId("langkah-simpan")).toBeVisible();
      await d.getByRole("button", { name: "Simpan Selesai" }).click();
      await waitSynced(d);
      await driver.context.close();

      await menu.getByRole("button", { name: "Pasokan air" }).click();
      const arrived = p.getByTestId("pasokan-tiba").filter({ hasText: `${supplyOrder}/1` });
      // Rit pasokan Selesai di server lalu tertarik ke tablet (pull m6.pos). Sejak v1.0.1 (D-14 butir 2) tablet dengan
      // antrean kosong menarik data kantor tiap ±5 menit; operator yang menunggu truk mengetuk pil status (kirim
      // sekarang) seperti di panduan lapangan operator depot.
      await expect(async () => {
        if (!(await arrived.isVisible())) {
          await syncNow(p);
          throw new Error("pasokan belum tertarik");
        }
      }).toPass({ timeout: 90_000, intervals: [3_000] });
      await expect(arrived).toContainText("5.000 L");
      await arrived.getByRole("button", { name: "Sesuai, terima" }).click();
      await waitSynced(p);
      await expect(p.getByTestId("pasokan-tiba").filter({ hasText: `${supplyOrder}/1` })).toHaveCount(0, { timeout: 30_000 });
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 5–6: tutup shift dengan hitung fisik → serah setoran → Admin Keuangan menerima
    // -----------------------------------------------------------------------------------------------------------------
    let deposit = 0;
    await test.step("Tutup shift: kas fisik & stok bahan dihitung, setoran diserahkan", async () => {
      await menu.getByRole("button", { name: "Shift & void" }).click();
      await expect(p.getByRole("list", { name: "Transaksi shift" }).locator("li", { hasText: /135\.000/ }).first()).toContainText("Di-void", { timeout: 60_000 });
      const close = p.getByTestId("tutup-shift");
      const expected = digits(await close.getByTestId("tunai-seharusnya").textContent());
      // Kas awal 200.000 + tunai 10.000 + 5.000 (luring); QRIS & transaksi yang di-void tidak masuk laci.
      expect(expected).toBe(215_000);
      await close.getByLabel("Kas fisik di laci (hitung)").fill(String(expected));
      // Stok fisik bahan dihitung (tidak mungkin negatif); selisih dengan stok seharusnya wajib beralasan (US-M6-02 KP-5).
      for (const name of ["Tutup galon", "Tisu segel galon", "Galon kosong 19 L (bahan)"]) {
        const label = close.locator("label", { hasText: `${name} (fisik)` });
        const should = Number(/stok seharusnya (-?\d+)/.exec((await label.textContent()) ?? "")?.[1] ?? "0");
        await label.locator("input").fill(String(Math.max(0, should)));
      }
      const reasons = close.getByRole("textbox", { name: /^Alasan selisih [+-]?\d/ });
      for (let i = 0; i < (await reasons.count()); i++) await reasons.nth(i).fill("Hitung fisik akhir shift — stok bahan depot belum dipasok (skenario P-02)");
      await close.getByRole("button", { name: "Tutup shift" }).click();
      const handover = p.getByTestId("serah-setoran");
      await expect(handover).toBeVisible({ timeout: 30_000 });
      await waitSynced(p);
      deposit = expected - 200_000;
      await expect(handover).toContainText(rp(deposit));
      await handover.getByRole("button", { name: "Tandai sudah disetor" }).click();
      await expect(handover).toContainText("Setoran ditandai Disetor");
      await waitSynced(p);
    });

    await test.step("Admin Keuangan menerima setoran shift D05 (US-M4-02 KP-7)", async () => {
      const fa = await officeSession(browser, info, "keuangan1");
      await fa.page.goto("/kas/setoran");
      const row = fa.page.getByTestId("setoran-menunggu").getByRole("row").filter({ hasText: "Depot D05" });
      await expect(row).toHaveCount(1);
      await row.getByRole("link").first().click();
      const form = fa.page.getByTestId("form-terima-setoran");
      const calc = form.getByTestId("hitung-selisih");
      expect(Number(await calc.getAttribute("data-expected-net"))).toBe(deposit);
      await form.getByLabel("Jumlah fisik diterima (Rp)").fill(String(deposit));
      await expect(calc).toContainText("Rp 0");
      await form.getByRole("button", { name: "Terima setoran" }).click();
      await expect(fa.page.getByText("Hasil penerimaan")).toBeVisible();
      await fa.context.close();
    });
    await pos.context.close();
  });
});
