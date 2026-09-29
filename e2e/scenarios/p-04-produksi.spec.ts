import { expect, test, type Page } from "@playwright/test";

import {
  activateField,
  assignAndPublish,
  attachAllPages,
  createOrder,
  digits,
  issueActivationCode,
  officeSession,
  PHOTO,
  runTripFromDetail,
  syncNow,
  waitSynced,
  wibDate,
} from "./helpers";

/**
 * P-04 — Produksi (BRD Bab 5; PRD US-M8-01, US-M8-02, US-M8-03, US-M8-04, US-M6-05, US-M8-07).
 *
 * Sumber Air Warungkondang SA2 (ponsel HP-SA2, operator Tatang Sutisna): meter pagi (foto) → pengisian truk T4 untuk rit
 * pasokan depot D05 → sopir Cecep Hidayat menyerahkan → operator depot D05 mengonfirmasi volume diterima BERBEDA
 * (selisih kirim–terima) → meter malam → neraca air harian terbentuk dengan susut > ambang (BR-26) → operator mengisi
 * investigasi susut (alasan + foto) → pemilik menerima penjelasan → Selesai.
 */
const SA2 = { latitude: -6.8905, longitude: 107.0921 };
const D05 = { latitude: -6.8756, longitude: 107.1108 };
const RECEIVED_L = 4_950;

/** Catat satu pembacaan meter lewat alur 3 langkah (US-M8-01 KP-1). Mengembalikan angka yang dicatat. */
async function recordMeter(page: Page, phase: "Pagi" | "Malam", add: number): Promise<number> {
  await page.getByTestId("kartu-meter").getByRole("button", { name: "Catat meter" }).first().click();
  await expect(page.getByText("Langkah 1 dari 3")).toBeVisible();
  await page.getByRole("radiogroup", { name: "Pembacaan" }).getByRole("radio", { name: new RegExp(`^${phase}`) }).click();
  await page.getByRole("button", { name: "Lanjut" }).click();
  const step = page.getByTestId("langkah-angka");
  await expect(step).toBeVisible();
  // Angka terakhir tampil di langkah 2 (mis. "Terakhir 8.745.200 L"); angka baru = terakhir + produksi.
  const last = Math.max(...((await step.textContent()) ?? "").match(/\d{1,3}(?:\.\d{3})+/g)!.map((t) => digits(t)));
  const value = last + add;
  await page.getByLabel("Angka pada meter").fill(String(value));
  await page.getByRole("button", { name: "Lanjut" }).click();
  await expect(page.getByText("Langkah 3 dari 3")).toBeVisible();
  await page.getByLabel("Foto meter", { exact: true }).setInputFiles({ name: "meter.png", mimeType: "image/png", buffer: PHOTO });
  await expect(page.getByText(/Foto tersimpan/).first()).toBeVisible();
  const late = page.getByLabel("Alasan terlambat");
  if (await late.isVisible()) await late.fill("Skenario P-04 dijalankan di luar jam pembacaan");
  await page.getByRole("button", { name: "Simpan angka meter" }).click();
  await expect(page.getByTestId("meter-tersimpan")).toContainText(value.toLocaleString("id-ID"));
  await page.getByRole("button", { name: "Kembali ke Hari ini" }).click();
  return value;
}

test.describe("P-04 produksi — meter, pengisian, pasokan depot, neraca air & investigasi susut", () => {
  test.afterEach(async ({ browser }, info) => attachAllPages(browser, info));

  test("P-04 US-M8-01 KP-1 US-M8-02 KP-1 US-M8-03 KP-1 US-M6-05 KP-1 US-M8-04 KP-1 KP-2 US-M8-07 KP-1 sumber SA2 satu hari ujung ke ujung", async ({ browser }, info) => {
    const today = wibDate(0);
    const admin = await officeSession(browser, info, "admin1");
    const sourceCode = await issueActivationCode(admin.page, "HP-SA2", "Ponsel sumber SA2 dipasang ulang (skenario P-04)");
    const phoneCode = await issueActivationCode(admin.page, "HP-T4", "Ponsel truk T4 dipasang ulang (skenario P-04)");
    const posCode = await issueActivationCode(admin.page, "POS-D05", "Tablet POS D05 dipasang ulang (skenario P-04)");
    await admin.context.close();

    const dispatcher = await officeSession(browser, info, "dispatcher1");
    const supplyOrder = await createOrder(dispatcher.page, { internalDepot: "D05", date: today, notes: "Pasokan air depot D05 (skenario P-04)" });
    await assignAndPublish(dispatcher.page, today, [supplyOrder], "T4");
    await dispatcher.context.close();
    const tripNo = `${supplyOrder}/1`;

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 1: meter pagi dengan foto
    // -----------------------------------------------------------------------------------------------------------------
    const prod = await activateField(browser, info, { code: sourceCode, kind: "phone", app: "/produksi", user: /Tatang Sutisna/, geolocation: SA2 });
    const o = prod.page;
    await expect(o.getByRole("heading", { level: 1, name: "Produksi Air" })).toBeVisible();
    await expect(o.getByTestId("kartu-meter")).toBeVisible({ timeout: 30_000 });
    await test.step("Operator mencatat meter pagi (+ foto)", async () => {
      await recordMeter(o, "Pagi", 1_000);
      await waitSynced(o);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 2: pengisian truk per rit (rit pasokan depot T4)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Operator mengisi truk T4 5.000 L untuk rit pasokan depot (US-M8-02 KP-1)", async () => {
      await syncNow(o);
      await o.getByRole("navigation", { name: "Menu produksi" }).getByRole("button", { name: "Isi truk" }).click();
      const t4 = o.getByTestId("truk-T4");
      await expect(t4).toBeVisible({ timeout: 30_000 });
      await t4.click();
      await o.getByRole("button", { name: "Lanjut" }).click();
      await expect(o.getByLabel("Volume diisi")).toHaveValue("5.000");
      await o.getByRole("radiogroup", { name: "Rit tujuan" }).getByRole("radio", { name: new RegExp(tripNo) }).click();
      await o.getByRole("button", { name: "Lanjut" }).click();
      await expect(o.getByTestId("langkah-simpan-isi")).toContainText(tripNo);
      await o.getByRole("button", { name: "Simpan pengisian" }).click();
      await expect(o.getByTestId("isi-tersimpan")).toBeVisible();
      await o.getByRole("button", { name: "Kembali ke Hari ini" }).click();
      await waitSynced(o);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 3: sopir menyerahkan pasokan → depot mengonfirmasi volume BERBEDA (selisih kirim–terima ke M8 & Dispatcher)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Sopir T4 menyerahkan 5.000 L; operator D05 menerima 4.950 L beralasan (US-M6-05 KP-1, US-M8-03)", async () => {
      const driver = await activateField(browser, info, { code: phoneCode, kind: "phone", app: "/sopir", user: /Cecep Hidayat/, geolocation: D05 });
      const d = driver.page;
      await expect(d.getByRole("region", { name: "Rit hari ini" }).getByTestId(`rit-${tripNo}`)).toBeVisible({ timeout: 30_000 });
      await runTripFromDetail(d, { tripNo, point: D05, internal: true });
      await d.getByRole("button", { name: "Simpan Selesai" }).click();
      await waitSynced(d);
      await driver.context.close();

      const pos = await activateField(browser, info, { code: posCode, kind: "tablet", app: "/pos", user: /Wawan Gunawan/ });
      const p = pos.page;
      const menu = p.getByRole("navigation", { name: "Menu POS" });
      await expect(menu.or(p.getByTestId("buka-shift"))).toBeVisible({ timeout: 30_000 });
      await menu.getByRole("button", { name: "Pasokan air" }).click();
      const arrived = p.getByTestId("pasokan-tiba").filter({ hasText: tripNo });
      await expect(arrived).toBeVisible({ timeout: 60_000 });
      await arrived.getByRole("button", { name: "Volume berbeda" }).click();
      await arrived.getByLabel("Volume diterima").fill(String(RECEIVED_L));
      await arrived.getByLabel("Alasan beda volume").fill("Selang bocor saat bongkar, ±50 L tumpah");
      await arrived.getByRole("button", { name: "Simpan penerimaan" }).click();
      await waitSynced(p);
      await expect(p.getByTestId("pasokan-tiba").filter({ hasText: tripNo })).toHaveCount(0, { timeout: 30_000 });
      await pos.context.close();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 4: meter malam → neraca air harian → susut > ambang → investigasi (alasan + foto)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Operator mencatat meter malam TANPA SINYAL → terkirim → neraca susut di atas ambang → investigasi susut", async () => {
      // US-M8-07 KP-1: pembacaan meter tetap dapat dicatat tanpa sinyal (antre di ponsel), terkirim saat sinyal kembali.
      await prod.context.setOffline(true);
      await expect(o.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
      // Produksi = Σ (malam − pagi) = 19.000 L vs pengisian 5.000 L → susut 14.000 L (73,7 % > ambang 5 %, BR-26) → investigasi.
      await recordMeter(o, "Malam", 19_000);
      await expect(o.getByText(/Tersimpan di ponsel: \d+/).first()).toBeVisible();
      await prod.context.setOffline(false);
      await waitSynced(o);
      await syncNow(o);
      const task = o.getByTestId("tugas-investigasi").filter({ hasText: `Susut ${today}` });
      await expect(task).toBeVisible({ timeout: 60_000 });
      await task.getByRole("button", { name: "Isi penjelasan susut" }).click();
      const form = o.getByTestId("form-investigasi");
      await expect(form).toContainText("19.000 L");
      await expect(form).toContainText("5.000 L");
      await expect(form).toContainText("14.000 L");
      await form.getByRole("radiogroup", { name: "Alasan susut" }).getByRole("radio").first().click();
      await form.getByLabel(/Keterangan/).fill("Pipa distribusi bocor di sambungan tandon (skenario P-04)");
      await form.getByLabel("Foto bukti", { exact: true }).setInputFiles({ name: "susut.png", mimeType: "image/png", buffer: PHOTO });
      await expect(o.getByText(/Foto tersimpan/).first()).toBeVisible();
      await form.getByRole("button", { name: "Kirim penjelasan susut" }).click();
      await expect(o.getByTestId("investigasi-tersimpan")).toBeVisible();
      await waitSynced(o);
    });

    await test.step("Pemilik melihat neraca air & pasokan tiga angka, lalu menerima penjelasan susut (US-M8-04 KP-2, US-M8-03 KP-1)", async () => {
      const owner = await officeSession(browser, info, "pemilik");
      await owner.page.goto(`/produksi/neraca-air?tanggal=${today}`);
      const row = owner.page.getByTestId("tabel-neraca").getByRole("row").filter({ hasText: "Sumber Air Warungkondang" }).first();
      await expect(row).toBeVisible();
      const href = (await row.getByRole("link").first().getAttribute("href"))!;
      const sourceId = new URL(href, "http://x").searchParams.get("sumber")!;
      await owner.page.goto(`/produksi/neraca-air/rincian?sumber=${sourceId}&tanggal=${today}`);
      await expect(owner.page.getByTestId("penjelasan-susut")).toContainText("Pipa distribusi bocor");
      const accept = owner.page.getByTestId("form-terima-susut");
      await accept.getByLabel("Catatan (opsional)").fill("Diterima — sambungan sudah diganti (P-04)");
      await accept.getByRole("button", { name: "Terima penjelasan" }).click();
      await expect(owner.page.getByTestId("form-terima-susut")).toHaveCount(0);

      // Pasokan depot tiga angka: diisi M8 5.000 / diserahkan M3 5.000 / diterima M6 4.950 (selisih ditandai).
      await owner.page.goto(`/produksi/pengisian?tab=pasokan&dari=${today}&sampai=${today}`);
      const supply = owner.page.getByRole("row").filter({ hasText: tripNo }).first();
      await expect(supply).toContainText("4.950");
      await owner.context.close();
    });
    await prod.context.close();
  });
});
