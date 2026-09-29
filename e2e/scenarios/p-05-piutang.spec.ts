import { expect, test, type Page } from "@playwright/test";

import { formatTanggal } from "../../src/lib/time";

import {
  activateField,
  addDays,
  assignAndPublish,
  attachAllPages,
  createOrder,
  cronTick,
  customerIdOf,
  digits,
  issueActivationCode,
  moveTo,
  officeSession,
  offsetTo,
  PHOTO,
  rp,
  runTripFromDetail,
  setClock,
  signOnPad,
  stubWhatsApp,
  syncNow,
  waitSynced,
  waText,
  wibDate,
  wibInstant,
} from "./helpers";

/**
 * P-05 — Piutang (BRD Bab 5; PRD US-M5-01..05, US-M3-05, US-M2-05).
 *
 * Pelanggan Tempo bersih CV Bata Merah Sukamanah (PLG-0951, data awal khusus E2E `src/db/seed/e2e-scenarios.ts`; tempo
 * 14 hari, batas Rp 5.000.000) memesan 2 tangki tempo → truk T5 (sopir Iwan Setiawan, ponsel HP-T5):
 *  1. rit 1 Selesai tempo → faktur kirim otomatis (jatuh tempo = tanggal kirim + 14 hari), dikirim via tautan WA;
 *  2. pengingat H-3 (jam kantor digeser ke H-3) → WhatsApp berisi nomor faktur, jumlah, jatuh tempo, rekening;
 *  3. rit berikutnya: sopir menerima pelunasan sebagian atas faktur rit 1 (tertua) → bukti pelunasan WA;
 *  4. alokasi ke faktur tertua tampil di kantor; kas sopir bertambah (setoran hari itu);
 *  5. pengingat H+1 + umur piutang 1–7 hari;
 *  6. job harian PAR-55 pada jatuh tempo + 8 hari → Ditahan otomatis; pesanan tempo baru DITOLAK;
 *  7. pelunasan kantor penuh → Ditahan dilepas otomatis → Tempo kembali.
 * Waktu berlalu memakai jam tersuntik E2E (cookie kantor + `/api/cron/tick?now=`), bukan data yang diubah langsung.
 */
const CUSTOMER = { code: "PLG-0951", name: "CV Bata Merah Sukamanah", point: { latitude: -6.8215, longitude: 107.1905 } };
const TERM_DAYS = 14;
const COLLECTED = 100_000;

const tgl = (date: string) => formatTanggal(date, { weekday: false });

/** Langkah bayar & simpan rit tempo (US-M3-04: Tempo terpilih dari pesanan) lalu lewati struk WA beralasan. */
async function finishCreditTrip(d: Page): Promise<number> {
  await expect(d.getByTestId("langkah-bayar")).toBeVisible();
  const price = digits(await d.getByTestId("harga-bayar").textContent());
  await expect(d.getByRole("radiogroup", { name: "Cara bayar" }).getByRole("radio", { name: "Tempo" })).toHaveAttribute("aria-checked", "true");
  await expect(d.getByText("Tempo: tagihan dicatat sebagai piutang pelanggan")).toBeVisible();
  await d.getByRole("button", { name: "Lanjut" }).click();
  await expect(d.getByTestId("langkah-simpan")).toBeVisible();
  await d.getByRole("button", { name: "Simpan Selesai" }).click();
  const receipt = d.getByTestId("struk-wa");
  await expect(receipt).toBeVisible();
  await receipt.getByRole("radio").first().click();
  await receipt.getByRole("button", { name: "Lewati & kembali ke daftar rit" }).click();
  return price;
}

test.describe("P-05 piutang — faktur tempo, pengingat, pelunasan sopir, umur, Ditahan otomatis, lepas", () => {
  test.afterEach(async ({ browser }, info) => attachAllPages(browser, info));

  test("P-05 US-M5-01 KP-1 KP-3 KP-5 US-M5-05 KP-1 US-M3-05 KP-1 KP-2 KP-3 KP-5 US-M5-02 KP-1 KP-2 US-M5-04 KP-1 KP-3 US-M5-03 KP-1 KP-3 KP-4 US-M2-05 KP-1 pelanggan tempo PLG-0951 ujung ke ujung", async ({ browser }, info) => {
    const today = wibDate(0);
    const due = addDays(today, TERM_DAYS);
    const customerId = customerIdOf(CUSTOMER.code);

    // -----------------------------------------------------------------------------------------------------------------
    // Persiapan: pesanan tempo 2 tangki → T5 → terbit; ponsel T5 diaktifkan
    // -----------------------------------------------------------------------------------------------------------------
    const dispatcher = await officeSession(browser, info, "dispatcher1");
    const order = await createOrder(dispatcher.page, { customer: CUSTOMER.name, date: today, payment: "credit", tanks: 2, notes: "Bongkar di bak gudang bata (skenario P-05)" });
    const [trip1, trip2] = [`${order}/1`, `${order}/2`];
    await assignAndPublish(dispatcher.page, today, [trip1, trip2], "T5");

    const admin = await officeSession(browser, info, "admin1");
    const code = await issueActivationCode(admin.page, "HP-T5", "Ponsel truk T5 dipasang ulang (skenario P-05)");
    await admin.context.close();
    const driver = await activateField(browser, info, { code, kind: "phone", app: "/sopir", user: /Iwan Setiawan/, geolocation: CUSTOMER.point });
    await stubWhatsApp(driver.context);
    const d = driver.page;
    const list = d.getByRole("region", { name: "Rit hari ini" });
    await expect(list.getByTestId(`rit-${trip1}`)).toBeVisible({ timeout: 30_000 });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 1: rit tempo Selesai → faktur kirim otomatis per rit (US-M5-01 KP-1) → dikirim via tautan WA (KP-5)
    // -----------------------------------------------------------------------------------------------------------------
    let price = 0;
    await test.step("Sopir T5 menyelesaikan rit 1 tempo", async () => {
      await runTripFromDetail(d, { tripNo: trip1, point: CUSTOMER.point, recipient: "Pak Dudi (gudang)" });
      price = await finishCreditTrip(d);
      expect(price).toBeGreaterThan(0);
      await waitSynced(d);
    });

    const fa = await officeSession(browser, info, "keuangan1");
    await stubWhatsApp(fa.context);
    let invoice1 = "";
    let invoice1Url = "";
    await test.step("Faktur kirim terbit otomatis: jatuh tempo = tanggal kirim + 14 hari; dikirim via tautan WA", async () => {
      await fa.page.goto("/piutang/faktur");
      const row = fa.page.getByTestId("daftar-faktur").getByRole("row").filter({ hasText: CUSTOMER.name });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await expect(row).toContainText(tgl(due));
      await expect(row).toContainText(rp(price));
      invoice1 = /F-\d{2}-\d{6}/.exec((await row.textContent()) ?? "")![0];
      await row.getByRole("link", { name: invoice1 }).click();
      await expect(fa.page).toHaveURL(/\/piutang\/faktur\/[0-9a-f-]{36}$/);
      invoice1Url = new URL(fa.page.url()).pathname;
      await expect(fa.page.getByText(trip1, { exact: true })).toBeVisible();
      await expect(fa.page.getByTestId("sisa-faktur")).toHaveText(rp(price));
      const popup = fa.context.waitForEvent("page");
      await fa.page.getByTestId("kirim-wa-faktur").click();
      const wa = await popup;
      expect(wa.url()).toMatch(/^https:\/\/wa\.me\/6281399990951\?text=/);
      expect(waText(wa.url())).toContain(invoice1);
      await wa.close();
      await fa.page.reload();
      await expect(fa.page.getByText(/lewat WhatsApp/i).first()).toBeVisible();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 2: pengingat H-3 (jam kantor = H-3 08.00; job harian menjadwalkan) → WhatsApp terisi → "Dibuka"
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Pengingat H-3: daftar harian → Buka WhatsApp (nomor faktur, jumlah, jatuh tempo, rekening) → Dibuka", async () => {
      const dayBefore = addDays(due, -3);
      const ran = await cronTick(fa.page, { only: ["m5.reminders.daily"], now: wibInstant(dayBefore, "05:05") });
      expect(ran.find((r) => r.key === "m5.reminders.daily")?.status).toBe("succeeded");
      await setClock(fa.context, info, offsetTo(dayBefore, "08:00"));
      await fa.page.goto("/piutang/pengingat");
      const row = fa.page.getByTestId(`pengingat-${CUSTOMER.code}-before_due`);
      await expect(row).toContainText(CUSTOMER.name);
      await expect(row).toContainText(invoice1);
      await expect(row).toContainText("Dijadwalkan");
      const popup = fa.context.waitForEvent("page");
      await row.getByRole("button", { name: "Buka WhatsApp" }).click();
      const wa = await popup;
      const text = waText(wa.url());
      expect(wa.url()).toMatch(/^https:\/\/wa\.me\/6281399990951\?text=/);
      expect(text).toContain(invoice1);
      expect(text).toContain(price.toLocaleString("id-ID"));
      expect(text).toContain(tgl(due));
      await wa.close();
      await expect(row).toContainText("Dibuka");
      await setClock(fa.context, info, 0);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 3: rit berikutnya — sopir menerima pelunasan sebagian atas faktur tertua (US-M3-05) + bukti WA
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Rit 2: faktur terbuka tampil dari data sinkron → Terima pelunasan sebagian (tunai) → bukti pelunasan WA", async () => {
      await syncNow(d);
      await moveTo(d, CUSTOMER.point);
      d.once("dialog", (dlg) => void dlg.accept());
      await list.getByTestId(`rit-${trip2}`).locator("[data-slot='field-list-item']").click();
      const open = d.getByTestId("faktur-terbuka");
      // Faktur rit 1 terbit di server lalu tertarik ke ponsel (pull m3.today) — tunggu sinkron berikutnya bila perlu.
      await expect(async () => {
        if (!(await open.isVisible())) {
          await syncNow(d);
          throw new Error("faktur belum tertarik");
        }
      }).toPass({ timeout: 90_000, intervals: [3_000] });
      await expect(open).toContainText(invoice1);
      await expect(open).toContainText(rp(price));
      await d.getByRole("button", { name: "Berangkat" }).click();
      await d.getByRole("button", { name: "Tiba" }).click();
      await expect(d.getByRole("button", { name: "Tiba" })).toHaveCount(0);
      await open.getByRole("button", { name: "Terima pelunasan" }).click();
      const form = d.getByTestId("form-pelunasan");
      await expect(form.getByRole("checkbox", { name: new RegExp(invoice1) })).toBeChecked();
      await form.getByLabel("Jumlah diterima").fill(String(COLLECTED));
      await expect(form).toContainText(`Dialokasikan: ${invoice1}`);
      await form.getByRole("button", { name: "Simpan pelunasan" }).click();
      const receipt = d.getByTestId("struk-wa");
      await expect(receipt).toContainText("Bukti pelunasan WA");
      const popup = driver.context.waitForEvent("page");
      await receipt.getByRole("link", { name: "Kirim struk WA" }).click();
      const wa = await popup;
      const text = waText(wa.url());
      expect(text).toContain(COLLECTED.toLocaleString("id-ID"));
      expect(text).toContain(invoice1);
      await wa.close();
      await waitSynced(d);

      // Selesaikan rit 2 (tempo) → faktur kedua.
      await list.getByTestId(`rit-${trip2}`).locator("[data-slot='field-list-item']").click();
      await d.getByRole("button", { name: "Selesai & bayar" }).click();
      await d.getByLabel("Foto bukti kirim", { exact: true }).setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: PHOTO });
      await expect(d.getByText(/Foto tersimpan/).first()).toBeVisible();
      await d.getByLabel("Nama penerima").fill("Pak Dudi (gudang)");
      await signOnPad(d);
      await d.getByRole("button", { name: "Lanjut" }).click();
      await finishCreditTrip(d);
      await waitSynced(d);
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 4: alokasi (tertua dulu) tampil di kantor tanpa input ulang; kas sopir masuk setoran hari itu (BR-07)
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Kantor: pelunasan sopir teralokasi ke faktur rit 1; umur piutang 'belum jatuh tempo'; sopir menyetor", async () => {
      await fa.page.goto(invoice1Url);
      await expect(fa.page.getByTestId("alokasi-faktur")).toContainText(rp(COLLECTED), { timeout: 30_000 });
      await expect(fa.page.getByTestId("sisa-faktur")).toHaveText(rp(price - COLLECTED));
      await fa.page.goto("/piutang/pelunasan");
      await expect(fa.page.getByTestId("daftar-pelunasan").getByRole("row").filter({ hasText: CUSTOMER.name }).filter({ hasText: rp(COLLECTED) })).toHaveCount(1);
      await fa.page.goto("/piutang/umur");
      const aging = fa.page.getByTestId("umur-pelanggan").getByRole("row").filter({ hasText: CUSTOMER.name });
      await expect(aging.getByRole("cell").nth(1)).toHaveText(rp(2 * price - COLLECTED));

      // US-M3-05 KP-3: pelunasan tunai menambah kas di tangan → Setor hari itu.
      await d.getByTestId("kas-di-tangan").click();
      const setor = d.getByTestId("setor");
      await expect(setor).toContainText(rp(COLLECTED));
      await setor.getByRole("button", { name: /^Setor Rp/ }).click();
      await waitSynced(d);
      await expect(d.getByTestId("setoran-diajukan")).toContainText(/Setoran S-\d{2}-\d{6} diajukan/, { timeout: 30_000 });
      await driver.context.close();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 5: H+1 — pengingat sesudah jatuh tempo & umur 1–7 hari (jam kantor = jatuh tempo + 1)
    // -----------------------------------------------------------------------------------------------------------------
    const outstanding = 2 * price - COLLECTED;
    await test.step("H+1: pengingat sesudah jatuh tempo (2 faktur) + daftar tindakan + umur 1–7 hari", async () => {
      const dayAfter = addDays(due, 1);
      await setClock(fa.context, info, offsetTo(dayAfter, "08:00"));
      await fa.page.goto("/piutang/pengingat");
      const row = fa.page.getByTestId(`pengingat-${CUSTOMER.code}-after_due`);
      await expect(row).toContainText("H+1 sesudah jatuh tempo");
      await expect(row).toContainText(rp(outstanding));
      const popup = fa.context.waitForEvent("page");
      await row.getByRole("button", { name: "Buka WhatsApp" }).click();
      const text = waText((await popup).url());
      expect(text).toContain(invoice1);
      expect(text).toMatch(/F-\d{2}-\d{6}, F-\d{2}-\d{6}/);
      expect(text).toContain(outstanding.toLocaleString("id-ID"));
      await expect(row).toContainText("Dibuka");

      await fa.page.goto("/piutang");
      await expect(fa.page.getByTestId("tindakan-ingatkan")).toContainText(CUSTOMER.name);
      await fa.page.goto("/piutang/umur");
      const aging = fa.page.getByTestId("umur-pelanggan").getByRole("row").filter({ hasText: CUSTOMER.name });
      await expect(aging.getByRole("cell").nth(2)).toHaveText(rp(outstanding));
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 6: lewat tempo > PAR-09 (7 hari) → job harian PAR-55 → Ditahan otomatis → pesanan tempo ditolak
    // -----------------------------------------------------------------------------------------------------------------
    const holdDay = addDays(due, 8);
    const nextDay = addDays(due, 9);
    await test.step("Jatuh tempo + 8 hari: job PAR-55 menahan pelanggan (BR-03) → Dispatcher: pesanan tempo ditolak", async () => {
      const ran = await cronTick(fa.page, { only: ["m5.credit_hold.daily"], now: wibInstant(holdDay, "22:35") });
      expect(ran.find((r) => r.key === "m5.credit_hold.daily")?.status).toBe("succeeded");

      await setClock(fa.context, info, offsetTo(nextDay, "08:00"));
      await fa.page.goto("/piutang/status-kredit");
      await expect(fa.page.getByTestId("daftar-ditahan").getByRole("row", { name: new RegExp(CUSTOMER.name) })).toBeVisible();
      await fa.page.goto(`/piutang/pelanggan/${customerId}`);
      await expect(fa.page.getByTestId("riwayat-status-kredit")).toContainText(/Otomatis: 2 faktur lewat tempo lebih dari 7 hari/);

      await setClock(dispatcher.context, info, offsetTo(nextDay, "08:10"));
      await dispatcher.page.goto("/pesanan/baru");
      await dispatcher.page.locator("#f-customer").click();
      await dispatcher.page.getByPlaceholder("Ketik minimal 2 karakter").fill(CUSTOMER.name.slice(0, 14));
      await dispatcher.page.getByRole("option", { name: new RegExp(CUSTOMER.name) }).first().click();
      await dispatcher.page.locator("#f-paymentMethod").selectOption("credit");
      await expect(dispatcher.page.getByTestId("harga-pesanan")).toContainText("Rp");
      await dispatcher.page.getByRole("button", { name: "Simpan pesanan" }).click();
      const rejected = dispatcher.page.getByRole("alert").filter({ hasText: "Pesanan tempo ditolak kontrol kredit" });
      await expect(rejected).toBeVisible();
      await expect(rejected).toContainText("Ditahan");
      await expect(rejected.getByRole("button", { name: "Ajukan persetujuan pemilik" })).toBeVisible();
      await expect(dispatcher.page.getByTestId("pesanan-tersimpan")).toHaveCount(0);
      await dispatcher.context.close();
    });

    // -----------------------------------------------------------------------------------------------------------------
    // Langkah 7: pelunasan kantor penuh (tertua dulu) → Ditahan dilepas otomatis (US-M5-03 KP-3) → riwayat status
    // -----------------------------------------------------------------------------------------------------------------
    await test.step("Pelunasan kantor penuh → Ditahan dilepas otomatis → status Tempo kembali", async () => {
      await fa.page.goto("/piutang");
      await expect(fa.page.getByTestId("tindakan-ditahan")).toContainText(CUSTOMER.name);
      await fa.page.goto(`/piutang/pelunasan?pelanggan=${customerId}`);
      const form = fa.page.getByTestId("form-pelunasan");
      await form.getByLabel("Jumlah (Rp)").fill(String(outstanding));
      await form.getByLabel("Cara bayar").selectOption("cash");
      await form.getByRole("button", { name: "Simpan pelunasan" }).click();
      await expect(form.getByRole("status")).toContainText(new RegExp(`Pelunasan ${rp(outstanding).source} tercatat — dialokasikan ke 2 faktur`));

      await fa.page.goto("/piutang/status-kredit");
      await expect(fa.page.locator('[data-testid="daftar-ditahan"]', { hasText: CUSTOMER.name })).toHaveCount(0);
      await fa.page.goto(`/piutang/pelanggan/${customerId}`);
      await expect(fa.page.getByTestId("riwayat-status-kredit")).toContainText("seluruh faktur lewat tempo sudah lunas");
      await fa.page.goto(invoice1Url);
      await expect(fa.page.getByTestId("sisa-faktur")).toHaveText(rp(0));
      await fa.context.close();
    });
  });
});
