import { expect, test, type Page } from "@playwright/test";

import {
  syncNow,
  moveTo,
  signOnPad,
  activateField,
  attachAllPages,
  addDays,
  cronTick,
  digits,
  enterPin,
  GPS_TOKEN,
  issueActivationCode,
  officeSession,
  offsetTo,
  PHOTO,
  rp,
  setClock,
  stubWhatsApp,
  waitSynced,
  waText,
  wibDate,
} from "./helpers";

/**
 * P-01 — Air truk (BRD Bab 5; PRD US-M2-01, US-M2-03, US-M3-01..04, US-M3-07, US-M12-05, US-M4-02, BR-10).
 *
 * Satu hari truk T6 (sopir Yayan Sopyan, ponsel HP-T6): Dispatcher membuat 4 pesanan (tunai, transfer, tempo, dan satu
 * yang akhirnya kurang bayar) → menugaskan & menerbitkan jadwal → sopir Berangkat/Tiba/Selesai dengan foto + tanda tangan
 * + nama penerima dan mencatat pembayaran (satu rit Selesai TANPA SINYAL) → struk WA (tautan) → posisi GPS di luar jadwal
 * terdeteksi (simulasi penghubung vendor + job deteksi) → sopir memberi keterangan → Setor → Admin Keuangan menerima →
 * rit truk T6 HARI BERIKUTNYA terbuka (jam tersuntik E2E: kantor & ponsel digeser ke besok pagi).
 */

type Stop = { code: string; name: string; point: { latitude: number; longitude: number }; pay: "cash" | "transfer" | "credit" | "under" };

/** Pelanggan seed (src/db/seed/customers.ts) — koordinat alamat Dikunci. */
const STOPS: Stop[] = [
  { code: "PLG-0021", name: "Perumahan Taman Sukaluyu", point: { latitude: -6.8203, longitude: 107.2352 }, pay: "cash" },
  { code: "PLG-0029", name: "Proyek Jalan Cibeber — PT Karya Bangun", point: { latitude: -6.912, longitude: 107.1455 }, pay: "transfer" },
  { code: "PLG-0025", name: "CV Tahu Cibuntu Sejahtera", point: { latitude: -6.835, longitude: 107.165 }, pay: "credit" },
  { code: "PLG-0022", name: "Perumahan Graha Karangtengah", point: { latitude: -6.7985, longitude: 107.1745 }, pay: "under" },
];
const UNDERPAID = 50_000;
/** Pool truk (src/db/seed/org.ts POOL_SEED) dan titik "warung" di luar lokasi sah (bukan alamat rit/sumber/depot/pool). */
const POOL = { lat: -6.8121, lng: 107.1605 };
const OFF_ROUTE = { lat: -6.833, lng: 107.18 };

/** Pesanan baru di satu layar (US-M2-01). Mengembalikan nomor pesanan. */
async function createOrder(page: Page, stop: Stop, date: string): Promise<string> {
  await page.goto("/pesanan/baru");
  await expect(page.getByRole("heading", { level: 1, name: "Pesanan baru" })).toBeVisible();
  await page.locator("#f-customer").click();
  await page.getByPlaceholder("Ketik minimal 2 karakter").fill(stop.name.slice(0, 18));
  await page.getByRole("option", { name: new RegExp(stop.name.slice(0, 18)) }).first().click();
  await expect(page.locator("#f-customer")).toContainText(stop.name.slice(0, 18));
  await page.locator("#f-requestedDate").fill(date);
  const method = stop.pay === "under" ? "cash" : stop.pay;
  await page.locator("#f-paymentMethod").selectOption(method);
  await expect(page.getByTestId("harga-pesanan")).toContainText("Rp");
  // BR-20: lewat jam batas → sistem mengusulkan besok; kirim hari ini wajib beralasan.
  const force = page.getByLabel("Alasan paksa kirim hari ini");
  if (await force.isVisible().catch(() => false)) await force.fill("Skenario P-01: pelanggan minta dikirim hari ini");
  await page.getByRole("button", { name: "Simpan pesanan" }).click();
  const saved = page.getByTestId("pesanan-tersimpan");
  // US-M2-01: pesanan pelanggan/alamat/tanggal sama sudah ada (mis. data demo) → konfirmasi pesanan tambahan beralasan.
  const duplicate = page.getByRole("alert").filter({ hasText: "Kemungkinan pesanan dobel" });
  await expect(saved.or(duplicate)).toBeVisible();
  if (await duplicate.isVisible()) {
    await duplicate.getByLabel("Alasan pesanan tambahan").fill("Rit tambahan permintaan pelanggan (skenario P-01)");
    await duplicate.getByRole("button", { name: "Ini pesanan tambahan" }).click();
  }
  await expect(saved).toBeVisible();
  const number = (await saved.getByLabel("Nomor pesanan").textContent())!.trim();
  expect(number).toMatch(/^P-\d{2}-\d{6}$/);
  return number;
}

test.describe("P-01 air truk — pesanan → jadwal → sopir → bayar → struk → GPS → setor → rit besok terbuka", () => {
  test.afterEach(async ({ browser }, info) => attachAllPages(browser, info));

  test("P-01 US-M2-01 KP-1 KP-7 US-M2-03 KP-2 US-M3-02 KP-1 US-M3-03 KP-1 KP-7 US-M3-04 KP-1 KP-2 US-M3-09 KP-2 US-M12-05 KP-1 US-M3-07 KP-1 US-M4-02 KP-1 BR-10 satu hari truk T6 ujung ke ujung", async ({ browser, page }, info) => {
    const today = wibDate(0);
    const tomorrow = addDays(today, 1);

    // Langkah 8 (sebagian): perangkat GPS T6 mengirim jejak (simulasi penghubung vendor, US-M12-01) — truk diam di pool
    // (lokasi sah) 30–24 menit lalu, lalu bergerak ±3 km ke warung (BUKAN lokasi sah) tanpa rit berjalan dan diam di sana
    // ≥ PAR-49. Posisi terbaru 9 menit lalu (< PAR-42 → bukan selisih jam; di luar jendela konsistensi rit ± 5 menit).
    await test.step("Penghubung GPS vendor menerima jejak T6 (simulasi perangkat)", async () => {
      const now = Date.now();
      const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
      const positions: Record<string, unknown>[] = [];
      for (let m = 30; m >= 24; m--) positions.push({ deviceId: "GPS-T6", time: at(m), lat: POOL.lat, lng: POOL.lng, speedKmh: 0 });
      for (let k = 1; k <= 8; k++) {
        const f = k / 8;
        positions.push({ deviceId: "GPS-T6", time: at(24 - k), lat: POOL.lat + (OFF_ROUTE.lat - POOL.lat) * f, lng: POOL.lng + (OFF_ROUTE.lng - POOL.lng) * f, speedKmh: 30 });
      }
      for (let m = 15; m >= 9; m--) positions.push({ deviceId: "GPS-T6", time: at(m), lat: OFF_ROUTE.lat, lng: OFF_ROUTE.lng, speedKmh: 0 });
      const res = await page.request.post("/api/gps/ingest/generic-json", {
        data: { positions: positions.map((p) => ({ ...p, heading: 200, accuracyM: 8, power: true })) },
        headers: { authorization: `Bearer ${GPS_TOKEN}` },
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: positions.length });
    });

    // ---------------------------------------------------------------------------------------------------------------
    // Langkah 1–2: Dispatcher membuat pesanan (< 60 dtk untuk pesanan pertama) — tunai, transfer, tempo, (kurang bayar)
    // ---------------------------------------------------------------------------------------------------------------
    const dispatcher = await officeSession(browser, info, "dispatcher1");
    const orders: string[] = [];
    await test.step("Dispatcher: 4 pesanan hari ini + 1 pesanan besok untuk T6", async () => {
      const started = Date.now();
      orders.push(await createOrder(dispatcher.page, STOPS[0]!, today));
      // US-M2-01 KP-7 (proksi otomatis): alur satu layar tersimpan jauh di bawah 60 detik.
      expect(Date.now() - started).toBeLessThan(60_000);
      for (const stop of STOPS.slice(1)) orders.push(await createOrder(dispatcher.page, stop, today));
      orders.push(await createOrder(dispatcher.page, STOPS[0]!, tomorrow));
    });

    // ---------------------------------------------------------------------------------------------------------------
    // Langkah 3: papan jadwal → tugaskan ke T6 → terbitkan (hari ini & besok)
    // ---------------------------------------------------------------------------------------------------------------
    await test.step("Dispatcher: papan jadwal — tugaskan rit ke T6 lalu terbitkan", async () => {
      for (const [date, list] of [
        [today, orders.slice(0, 4)],
        [tomorrow, orders.slice(4)],
      ] as const) {
        await dispatcher.page.goto(`/jadwal?tanggal=${date}`);
        await expect(dispatcher.page.getByRole("heading", { level: 1, name: "Papan jadwal" })).toBeVisible();
        const pending = dispatcher.page.getByRole("region", { name: "Belum terjadwal" });
        for (const order of list) {
          const tripNo = `${order}/1`;
          const card = pending.getByRole("article", { name: `Rit ${tripNo}` });
          await expect(card).toBeVisible();
          const select = card.getByLabel(`Truk untuk ${tripNo}`);
          const option = select.locator("option", { hasText: /^T6\b/ });
          await select.selectOption((await option.getAttribute("value"))!);
          await card.getByRole("button", { name: "Tugaskan" }).click();
          await expect(dispatcher.page.getByRole("region", { name: "Truk T6" }).getByRole("article", { name: `Rit ${tripNo}` })).toBeVisible();
        }
        const lane = dispatcher.page.getByRole("region", { name: "Truk T6" });
        await lane.getByRole("button", { name: "Terbitkan", exact: true }).click();
        for (const order of list) await expect(lane.getByRole("article", { name: `Rit ${order}/1` }).getByText("Terbit", { exact: true })).toBeVisible();
      }
    });

    // ---------------------------------------------------------------------------------------------------------------
    // Langkah 4–7: sopir T6 — Berangkat / Tiba / Selesai (foto, tanda tangan, penerima) + bayar + struk WA
    // ---------------------------------------------------------------------------------------------------------------
    const admin = await officeSession(browser, info, "admin1");
    const code = await issueActivationCode(admin.page, "HP-T6", "Ponsel truk T6 dipasang ulang (skenario P-01)");
    await admin.context.close();
    const driver = await activateField(browser, info, { code, kind: "phone", app: "/sopir", user: /Yayan Sopyan/, geolocation: STOPS[0]!.point });
    await stubWhatsApp(driver.context);
    const d = driver.page;
    await expect(d.getByRole("heading", { level: 1, name: "Aplikasi Sopir" })).toBeVisible();
    const list = d.getByRole("region", { name: "Rit hari ini" });
    await expect(list.getByRole("heading", { name: /Rit hari ini · T6 \(0\/4 selesai\)/ })).toBeVisible({ timeout: 30_000 });

    for (let i = 0; i < STOPS.length; i++) {
      // US-M3-01 KP-1: rit berikutnya (urutan aplikasi) ditonjolkan dengan tombol Berangkat — kerjakan sesuai urutan itu.
      const nextCard = list.locator("[data-testid^='rit-']").filter({ has: d.getByRole("button", { name: "Berangkat" }) });
      await expect(nextCard).toHaveCount(1);
      const cardText = (await nextCard.textContent()) ?? "";
      const card = list.getByTestId((await nextCard.getAttribute("data-testid"))!);
      const stop = STOPS.find((s) => cardText.includes(s.name))!;
      expect(stop, cardText).toBeTruthy();
      const orderNo = orders[STOPS.indexOf(stop)]!;
      await test.step(`Sopir: rit ${orderNo}/1 ${stop.name} (${stop.pay})`, async () => {
        await moveTo(d, stop.point);
        await expect(card).toContainText(`${orderNo}/1`);
        await card.getByRole("button", { name: "Berangkat" }).click();
        await card.getByRole("button", { name: "Tiba" }).click();
        // Rit ke-2 diselesaikan TANPA SINYAL (US-M3-09 KP-2): tersimpan di ponsel, terkirim saat sinyal kembali.
        const offline = i === 1;
        if (offline) {
          await driver.context.setOffline(true);
          await expect(d.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
        }
        await card.getByRole("button", { name: "Selesai & bayar" }).click();
        // US-M3-03 KP-1: foto + nama penerima + tanda tangan.
        await expect(d.getByTestId("langkah-bukti")).toBeVisible();
        await d.getByLabel("Foto bukti kirim", { exact: true }).setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: PHOTO });
        await expect(d.getByText(/Foto tersimpan/).first()).toBeVisible();
        await d.getByLabel("Nama penerima").fill(`Penerima ${stop.code}`);
        await signOnPad(d);
        await d.getByRole("button", { name: "Lanjut" }).click();

        // US-M3-04: pembayaran tidak dapat dilewati; harga = harga pesanan (BR-19).
        await expect(d.getByTestId("langkah-bayar")).toBeVisible();
        const price = digits(await d.getByTestId("harga-bayar").textContent());
        expect(price).toBeGreaterThan(0);
        const payments = d.getByRole("radiogroup", { name: "Cara bayar" });
        if (stop.pay === "transfer") {
          await expect(payments.getByRole("radio", { name: "Transfer" })).toHaveAttribute("aria-checked", "true");
          await d.getByLabel("Foto bukti transfer", { exact: true }).setInputFiles({ name: "transfer.png", mimeType: "image/png", buffer: PHOTO });
        } else if (stop.pay === "credit") {
          await expect(payments.getByRole("radio", { name: "Tempo" })).toHaveAttribute("aria-checked", "true");
          await expect(d.getByText("Tempo: tagihan dicatat sebagai piutang pelanggan")).toBeVisible();
        } else {
          await expect(payments.getByRole("radio", { name: "Tunai" })).toHaveAttribute("aria-checked", "true");
          if (stop.pay === "under") {
            // PTB-18: uang kurang → kurang bayar beralasan (faktur kurang bayar H+0 di M5).
            await d.getByTestId("uang-diterima").fill(String(price - UNDERPAID));
            await expect(d.getByText(new RegExp(`Kurang bayar ${rp(UNDERPAID).source}`))).toBeVisible();
            await d.getByRole("radiogroup", { name: "Alasan kurang bayar" }).getByRole("radio").first().click();
          }
        }
        await d.getByRole("button", { name: "Lanjut" }).click();
        await expect(d.getByTestId("langkah-simpan")).toBeVisible();
        await d.getByRole("button", { name: "Simpan Selesai" }).click();

        // US-M3-03 KP-7: struk WA satu ketukan (tautan wa.me berisi nomor rit, volume, harga, cara bayar).
        const receipt = d.getByTestId("struk-wa");
        await expect(receipt).toBeVisible();
        if (stop.pay === "cash") {
          const popup = driver.context.waitForEvent("page");
          await receipt.getByRole("link", { name: "Kirim struk WA" }).click();
          const wa = await popup;
          expect(wa.url()).toMatch(/^https:\/\/wa\.me\/62\d+\?text=/);
          const text = waText(wa.url());
          expect(text).toContain(`${orderNo}/1`);
          expect(text).toMatch(/5\.000 L/);
          expect(text).toMatch(/Tunai/);
          await wa.close();
        } else {
          await receipt.getByRole("radio").first().click();
          await receipt.getByRole("button", { name: "Lewati & kembali ke daftar rit" }).click();
        }
        await expect(list.getByRole("heading", { name: new RegExp(`Rit hari ini · T6 \\(${i + 1}/4 selesai\\)`) })).toBeVisible();
        if (offline) {
          await expect(d.getByText(/Tersimpan di ponsel: \d+/).first()).toBeVisible();
          await driver.context.setOffline(false);
        }
        await waitSynced(d);
      });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Langkah 8: perjalanan di luar jadwal terdeteksi (posisi GPS simulasi, job deteksi) → keterangan sopir → tinjauan
    // ---------------------------------------------------------------------------------------------------------------
    await test.step("GPS: job deteksi menandai perjalanan T6 di luar jadwal/jam → sopir memberi keterangan → pemilik menerima", async () => {
      // Job 5 menit `m12.detection.travel` dipicu lewat /api/cron/tick (idempoten per slot; slot yang sudah terpakai →
      // slot berikutnya dengan waktu tersuntik E2E).
      let status = "";
      for (let slot = 0; slot < 3 && status !== "succeeded"; slot++) {
        const ran = await cronTick(page, { only: ["m12.detection.travel"], now: new Date(Date.now() + slot * 5 * 60_000) });
        status = ran.find((r) => r.key === "m12.detection.travel")?.status ?? "";
      }
      expect(status).toBe("succeeded");
      // Aplikasi sopir: tugas Keterangan (BR-25) dari pull m3.today.
      await syncNow(d);
      await d.getByRole("navigation", { name: "Menu sopir" }).getByRole("button", { name: /^Keterangan/ }).click();
      await expect(d.getByRole("heading", { name: /Perjalanan di luar (jadwal|jam layanan)/ }).first()).toBeVisible({ timeout: 75_000 });
      await expect(d.getByText(/^Truk T6 · /).first()).toBeVisible();
      await d.getByLabel("Keterangan Anda").first().fill("Ke tambal ban di Cibeber sebelum rit pertama (skenario P-01)");
      await d.getByRole("button", { name: "Kirim keterangan" }).first().click();
      await waitSynced(d);

      const owner = await officeSession(browser, info, "pemilik");
      await owner.page.goto("/armada/kejadian");
      const item = owner.page.getByTestId("daftar-kejadian").locator("li", { hasText: "tambal ban di Cibeber" }).first();
      await expect(item).toContainText("T6");
      await item.getByRole("link", { name: "Rincian & peta" }).click();
      await expect(owner.page.getByText(/tambal ban di Cibeber/).first()).toBeVisible();
      const accept = owner.page.getByTestId("aksi-terima");
      await accept.getByLabel("Catatan (opsional)").fill("Dikonfirmasi Dispatcher lewat telepon (P-01)");
      await accept.getByRole("button", { name: "Terima alasan" }).click();
      await expect(owner.page.getByTestId("aksi-terima")).toHaveCount(0);
      await owner.context.close();
      await d.getByRole("navigation", { name: "Menu sopir" }).getByRole("button", { name: "Rit" }).click();
    });

    // ---------------------------------------------------------------------------------------------------------------
    // Langkah 9: Setor (kas di tangan = tunai rit 1 + tunai rit 4 kurang bayar; transfer & tempo tidak menambah kas)
    // ---------------------------------------------------------------------------------------------------------------
    let expectedCash = 0;
    await test.step("Sopir: kas di tangan → Setor", async () => {
      await d.getByTestId("kas-di-tangan").click();
      const setor = d.getByTestId("setor");
      expectedCash = digits(await setor.getByTestId("seharusnya-disetor").textContent());
      expect(expectedCash).toBeGreaterThan(0);
      await setor.getByRole("button", { name: /^Setor Rp/ }).click();
      await waitSynced(d);
      await expect(d.getByTestId("setoran-diajukan")).toContainText(/Setoran S-\d{2}-\d{6} diajukan/, { timeout: 30_000 });
    });

    // ---------------------------------------------------------------------------------------------------------------
    // Langkah 10: rit HARI BERIKUTNYA terkunci sampai Admin Keuangan menerima setoran (BR-10), lalu terbuka
    // ---------------------------------------------------------------------------------------------------------------
    const nextMorning = offsetTo(tomorrow, "07:00");
    await test.step("BR-10: papan jadwal besok (jam kantor digeser ke besok 07.00) — T6 terkunci karena setoran belum Ditutup", async () => {
      await setClock(dispatcher.context, info, nextMorning);
      await dispatcher.page.goto(`/jadwal?tanggal=${tomorrow}`);
      const lane = dispatcher.page.getByRole("region", { name: "Truk T6" });
      await expect(lane).toContainText("Rit terkunci di aplikasi sopir (BR-10)");
    });

    await test.step("Admin Keuangan menerima setoran sopir T6 (dihitung sistem) → Ditutup", async () => {
      const fa = await officeSession(browser, info, "keuangan1");
      await fa.page.goto("/kas/setoran");
      const row = fa.page.getByTestId("setoran-menunggu").getByRole("row").filter({ hasText: "Yayan Sopyan" });
      await expect(row).toHaveCount(1);
      await row.getByRole("link").first().click();
      await expect(fa.page.getByTestId("rincian-seharusnya")).toContainText(`${orders[0]}/1`);
      const form = fa.page.getByTestId("form-terima-setoran");
      const calc = form.getByTestId("hitung-selisih");
      expect(Number(await calc.getAttribute("data-expected-net"))).toBe(expectedCash);
      await form.getByLabel("Jumlah fisik diterima (Rp)").fill(String(expectedCash));
      await expect(calc).toContainText("Rp 0");
      await form.getByRole("button", { name: "Terima setoran" }).click();
      await expect(fa.page.getByText("Hasil penerimaan")).toBeVisible();
      await expect(fa.page.getByText("Ditutup").first()).toBeVisible();
      // Transfer rit 2 menunggu dicocokkan (P-06); kurang bayar rit 4 & tempo rit 3 menjadi faktur (M5).
      await fa.page.goto("/kas/transfer");
      await expect(fa.page.getByTestId("daftar-transfer")).toContainText(`${orders[1]}/1`);
      await fa.page.goto("/piutang/faktur");
      await expect(fa.page.getByTestId("daftar-faktur")).toContainText(STOPS[2]!.name);
      await expect(fa.page.getByTestId("daftar-faktur")).toContainText(STOPS[3]!.name);
      await fa.context.close();
    });

    await test.step("BR-10: besok pagi rit T6 terbuka — papan jadwal tanpa kunci & tombol Berangkat aktif di ponsel sopir", async () => {
      await dispatcher.page.reload();
      await expect(dispatcher.page.getByRole("region", { name: "Truk T6" })).not.toContainText("Rit terkunci di aplikasi sopir");
      await dispatcher.context.close();

      await setClock(driver.context, info, nextMorning, { browserClock: true });
      await d.reload();
      // Jam ponsel melompat ke besok pagi → layar terkunci (PAR-37) → sopir memasukkan PIN (sesi PIN ≤ 72 jam masih berlaku).
      const lock = d.getByRole("dialog", { name: "Layar terkunci" });
      if (await lock.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false)) await enterPin(d);
      const heading = d.getByRole("region", { name: "Rit hari ini" }).getByRole("heading", { name: /Rit hari ini · T6 \(0\/1 selesai\)/ });
      await expect(heading).toBeVisible({ timeout: 45_000 });
      const card = d.getByRole("region", { name: "Rit hari ini" }).locator("[data-testid^='rit-']").filter({ hasText: STOPS[0]!.name });
      await expect(card).toContainText(`${orders[4]}/1`);
      await expect(card.getByRole("button", { name: "Berangkat" })).toBeEnabled();
      await expect(d.getByText(/Setoran kemarin belum ditutup/)).toHaveCount(0);
      await driver.context.close();
    });
  });
});
