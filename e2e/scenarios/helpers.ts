/**
 * Pembantu skenario lintas modul BRD Bab 5 (P-01..P-07) — docs/qa/skenario-uji.md.
 *
 * Setiap skenario berjalan LEWAT ANTARMUKA NYATA: web kantor (konteks desktop), aplikasi sopir/produksi (konteks
 * ponsel), POS depot/toko (konteks tablet), memakai akun & perangkat seed. Langkah yang butuh waktu berlalu memakai
 * jam tersuntik khusus E2E (`src/server/core/e2e-clock.ts`, aktif hanya dengan `E2E_CLOCK_OVERRIDE=1` +
 * `ALLOW_DEV_SECRETS=1` dari playwright.config.ts): cookie `equa_e2e_clock` + jam peramban, dan `/api/cron/tick?now=`.
 */
import { devices, expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import { generate } from "otplib";

import { seedId } from "../../src/db/seed/ids";

export const PASSWORD = "equa-demo-2026";
export const PIN = "123456";
export const CRON_SECRET = "dev-cron-secret";
export const GPS_TOKEN = "dev-gps-ingest-token";
export const E2E_CLOCK_COOKIE = "equa_e2e_clock";
const DAY = 86_400_000;

const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
  keuangan2: "EQUADEMOKEUANGANDUARAHASIATOTPAA",
  admin1: "EQUADEMOADMINSATURAHASIATOTPAAAA",
  admin2: "EQUADEMOADMINDUARAHASIATOTPAAAAA",
};

export type OfficeUser = "pemilik" | "keuangan1" | "keuangan2" | "dispatcher1" | "dispatcher2" | "admin1" | "admin2" | "akuntan";

/** PNG 1×1 sah (foto uji; dikompres ulang di perangkat menjadi JPEG). */
export const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==", "base64");

/** Tanggal bisnis WIB `YYYY-MM-DD` (+ n hari) dari waktu (bawaan sekarang). */
export function wibDate(plusDays = 0, at: number = Date.now()): string {
  return new Date(at + 7 * 3_600_000 + plusDays * DAY).toISOString().slice(0, 10);
}

/** Instan UTC untuk tanggal WIB + jam WIB (`HH:MM`). */
export function wibInstant(date: string, hhmm: string): Date {
  return new Date(`${date}T${hhmm}:00+07:00`);
}

/** Tanggal pertama bulan berikutnya (WIB) dari tanggal `YYYY-MM-DD`. */
export function firstOfNextMonth(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Angka dari teks rupiah/volume ("Rp 1.250.000" → 1250000). */
export function digits(text: string | null | undefined): number {
  return Number((text ?? "").replace(/[^0-9]/g, "")) || 0;
}

/** Pola teks rupiah terformat (`formatRupiah` memakai spasi tak putus setelah "Rp"). */
export function rp(amount: number | string): RegExp {
  const text = typeof amount === "number" ? amount.toLocaleString("id-ID") : amount;
  return new RegExp(`Rp\\s?${text.replace(/\./g, "\\.")}`);
}

export const deviceIdOf = (code: string) => seedId(`device:${code}`);
export const customerIdOf = (code: string) => seedId(`customer:${code}`);
export const outletIdOf = (code: string) => seedId(`outlet:${code}`);

function baseUrl(info: TestInfo): string {
  return String(info.project.use.baseURL ?? "http://localhost:3000");
}

/** Konteks peramban baru (kantor desktop / ponsel / tablet) dengan lokal & zona waktu uji. */
export async function newContext(
  browser: Browser,
  info: TestInfo,
  kind: "desktop" | "phone" | "tablet",
  extra: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  const device = kind === "desktop" ? devices["Desktop Chrome"] : kind === "phone" ? devices["Pixel 7"] : devices["Galaxy Tab S4"];
  const context = await browser.newContext({ ...device, baseURL: baseUrl(info), locale: "id-ID", timezoneId: "Asia/Jakarta", ...extra });
  // Aksi gagal cepat (bukan menunggu batas waktu uji 15 menit) agar penyebabnya tampil jelas.
  context.setDefaultTimeout(20_000);
  // Server dev (`E2E_DEV=1`): sembunyikan tombol dev tools Next agar tidak menutupi menu bawah aplikasi lapangan.
  await context.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(style);
    });
  });
  context.setDefaultNavigationTimeout(60_000);
  return context;
}

/**
 * Masuk web kantor (kata sandi + TOTP demo bila perlu). Kode TOTP yang baru dipakai (anti-replay, mis. oleh spesifikasi
 * lain) → tunggu langkah waktu berikutnya.
 */
export async function loginOffice(page: Page, username: OfficeUser): Promise<void> {
  const used = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt === 0 || !/\/masuk\/2fa$/.test(page.url())) {
      await page.context().clearCookies({ name: "equa_session" });
      await page.goto("/masuk");
      await page.getByLabel("Nama pengguna").fill(username);
      await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
      await page.getByRole("button", { name: "Masuk", exact: true }).click();
    }
    const secret = TOTP[username];
    if (!secret) {
      await expect(page).toHaveURL(/\/beranda/);
      return;
    }
    await expect(page).toHaveURL(/\/masuk\/2fa$/);
    let code = await generate({ secret });
    if (used.has(code)) {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
      code = await generate({ secret });
    }
    used.add(code);
    await page.getByLabel("Kode verifikasi").fill(code);
    await page.getByRole("button", { name: "Verifikasi" }).click();
    const ok = await page
      .waitForURL(/\/beranda/, { timeout: 6_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  }
  throw new Error(`Gagal masuk sebagai ${username}`);
}

/** Konteks kantor desktop baru yang sudah masuk sebagai `username`. */
export async function officeSession(browser: Browser, info: TestInfo, username: OfficeUser, kind: "desktop" | "phone" = "desktop"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newContext(browser, info, kind);
  const page = await context.newPage();
  await loginOffice(page, username);
  return { context, page };
}

/** Admin sistem menerbitkan kode aktivasi baru untuk perangkat seed (M10 US-M10-02 KP-1) — kode sekali tampil. */
export async function issueActivationCode(adminPage: Page, deviceCode: string, reason: string): Promise<string> {
  await adminPage.goto(`/akses/perangkat/${deviceIdOf(deviceCode)}`);
  await adminPage.getByText("Terbitkan kode aktivasi baru").click();
  await adminPage.getByLabel("Alasan").last().fill(reason);
  await adminPage.getByRole("button", { name: "Terbitkan kode" }).click();
  const code = (await adminPage.getByTestId("kode-sekali").textContent())!.trim();
  expect(code.length).toBeGreaterThanOrEqual(6);
  return code;
}

/**
 * Aktivasi perangkat lapangan/POS di konteks ponsel/tablet baru → pilih pengguna → PIN. Mengembalikan konteks & halaman
 * aplikasi (`/sopir`, `/pos`, `/produksi`).
 */
export async function activateField(
  browser: Browser,
  info: TestInfo,
  opts: { code: string; kind: "phone" | "tablet"; app: "/sopir" | "/pos" | "/produksi"; user: RegExp; geolocation?: { latitude: number; longitude: number } },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newContext(browser, info, opts.kind, opts.geolocation ? { geolocation: opts.geolocation, permissions: ["geolocation"] } : {});
  const page = await context.newPage();
  await page.goto("/aktivasi-perangkat");
  await page.getByLabel("Kode aktivasi").fill(opts.code);
  await page.getByRole("button", { name: "Aktifkan" }).click();
  await expect(page).toHaveURL(new RegExp(`${opts.app}$`));
  await page.getByRole("button", { name: opts.user }).click();
  await enterPin(page);
  return { context, page };
}

export async function enterPin(page: Page): Promise<void> {
  for (const digit of PIN) await page.getByRole("button", { name: digit, exact: true }).click();
}

/**
 * Tunggu antrean perangkat terkirim ("Semua terkirim"). Antrean ditulis ke IndexedDB lalu pil status diperbarui secara
 * asinkron — beri jeda singkat agar pil "Semua terkirim" yang LAMA (sebelum aksi) tidak terbaca, lalu pastikan stabil.
 */
export async function waitSynced(page: Page, timeout = 45_000): Promise<void> {
  const pill = page.locator("[data-slot='sync-status-pill']").first();
  await page.waitForTimeout(750);
  await expect(pill).toContainText("Semua terkirim", { timeout });
  await page.waitForTimeout(500);
  await expect(pill).toContainText("Semua terkirim", { timeout });
}

/**
 * Geser jam sebuah konteks peramban sebesar `offsetMs` (jam tersuntik E2E): cookie `equa_e2e_clock` untuk server
 * (`ctx.now` kantor, `auth.now` perangkat) + jam peramban (waktu perangkat, Bab 5.3). `0` = kembali ke jam nyata.
 */
export async function setClock(context: BrowserContext, info: TestInfo, offsetMs: number, opts: { browserClock?: boolean } = {}): Promise<void> {
  await context.clearCookies({ name: E2E_CLOCK_COOKIE });
  if (offsetMs !== 0) {
    await context.addCookies([{ name: E2E_CLOCK_COOKIE, value: String(Math.round(offsetMs)), url: baseUrl(info) }]);
  }
  if (opts.browserClock) await context.clock.install({ time: Date.now() + offsetMs });
}

/** Selisih ms dari sekarang ke tanggal/jam WIB tertentu. */
export function offsetTo(date: string, hhmm: string): number {
  return wibInstant(date, hhmm).getTime() - Date.now();
}

/** Picu job terjadwal lewat `/api/cron/tick` (Bearer CRON_SECRET), opsional pada waktu tersuntik (E2E). */
export async function cronTick(page: Page, opts: { only: string[]; now?: Date }): Promise<{ key: string; status: string; result?: unknown; error?: string }[]> {
  const params = new URLSearchParams({ only: opts.only.join(",") });
  if (opts.now) params.set("now", opts.now.toISOString());
  const res = await page.request.post(`/api/cron/tick?${params}`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { ran: { key: string; status: string; result?: unknown; error?: string }[] };
  return body.ran;
}

/** Stub halaman wa.me agar tautan WhatsApp dapat dibuka tanpa internet (tautan tetap diperiksa). */
export async function stubWhatsApp(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>WhatsApp</title>" }));
}

/** Teks WA dari URL wa.me (`?text=`). */
export function waText(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get("text") ?? "");
}

/**
 * Setelah uji gagal: lampirkan tangkapan layar + cuplikan ARIA SEMUA halaman di semua konteks peramban (kantor, ponsel,
 * tablet) — fixture bawaan hanya merekam konteks `page`.
 */
export async function attachAllPages(browser: Browser, info: TestInfo): Promise<void> {
  if (info.status === info.expectedStatus) return;
  let n = 0;
  for (const context of browser.contexts()) {
    for (const p of context.pages()) {
      n++;
      try {
        const aria = await p.locator("body").ariaSnapshot({ timeout: 5_000 });
        await info.attach(`halaman-${n}-aria.txt`, { path: await writeOutput(info, `halaman-${n}-aria.txt`, `URL: ${p.url()}\n\n${aria}`), contentType: "text/plain" });
        const html = await p.locator("body").innerHTML({ timeout: 5_000 });
        await writeOutput(info, `halaman-${n}.html`, html);
      } catch {
        // halaman sudah tertutup
      }
    }
  }
}

async function writeOutput(info: TestInfo, name: string, body: string): Promise<string> {
  const path = info.outputPath(name);
  await writeFile(path, body, "utf8");
  return path;
}

/** Goreskan tanda tangan pada bidang tanda tangan aplikasi lapangan (US-M3-03 KP-1). */
export async function signOnPad(page: Page): Promise<void> {
  const pad = page.getByRole("img", { name: "Bidang tanda tangan kosong" });
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 5 });
  await page.mouse.move(box.x + 200, box.y + 50, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("img", { name: "Tanda tangan sudah diisi" })).toBeVisible();
}

/**
 * Ponsel "berpindah" ke titik baru: posisi emulasi diganti lalu dibaca segar sekali (maximumAge 0) sehingga aplikasi
 * yang memakai posisi tersimpan ≤ 30 detik (src/client/m3-driver/geo.ts) mendapat titik baru — seperti GPS ponsel yang
 * sudah memperbarui posisi saat truk tiba.
 */
export async function moveTo(page: Page, point: { latitude: number; longitude: number }): Promise<void> {
  await page.context().setGeolocation(point);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve(),
          () => resolve(),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 5_000 },
        );
      }),
  );
}

/**
 * Dispatcher membuat pesanan di satu layar (US-M2-01): pelanggan (cari nama) atau pasokan depot internal (kode depot),
 * tanggal, cara bayar. Menangani usulan kirim besok (BR-20, lewat jam batas → alasan) dan peringatan pesanan dobel
 * (pesanan tambahan beralasan). Mengembalikan nomor pesanan `P-YY-NNNNNN`.
 */
export async function createOrder(
  page: Page,
  opts: { customer?: string; internalDepot?: string; date: string; payment?: "cash" | "transfer" | "credit"; tanks?: number; notes?: string },
): Promise<string> {
  await page.goto("/pesanan/baru");
  await expect(page.getByRole("heading", { level: 1, name: "Pesanan baru" })).toBeVisible();
  if (opts.internalDepot) {
    await page.getByRole("button", { name: "Pasokan depot (internal)" }).click();
    const option = page.locator("#f-internal option", { hasText: new RegExp(`^${opts.internalDepot} `) });
    await page.locator("#f-internal").selectOption((await option.getAttribute("value"))!);
  } else {
    const query = opts.customer!.slice(0, 18);
    await page.locator("#f-customer").click();
    await page.getByPlaceholder("Ketik minimal 2 karakter").fill(query);
    await page.getByRole("option", { name: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    await expect(page.locator("#f-customer")).toContainText(query);
  }
  if (opts.tanks) await page.locator("#f-tankCount").fill(String(opts.tanks));
  await page.locator("#f-requestedDate").fill(opts.date);
  if (!opts.internalDepot && opts.payment) await page.locator("#f-paymentMethod").selectOption(opts.payment);
  if (opts.notes) await page.locator("#f-notes").fill(opts.notes);
  await expect(page.getByTestId("harga-pesanan")).toContainText("Rp");
  // BR-20: lewat jam batas → sistem mengusulkan besok; kirim hari ini wajib beralasan.
  const force = page.getByLabel("Alasan paksa kirim hari ini");
  if (await force.isVisible().catch(() => false)) await force.fill("Pelanggan minta dikirim hari ini (skenario E2E)");
  await page.getByRole("button", { name: "Simpan pesanan" }).click();
  const saved = page.getByTestId("pesanan-tersimpan");
  // US-M2-01: pesanan pelanggan/alamat/tanggal sama sudah ada (mis. data demo) → konfirmasi pesanan tambahan beralasan.
  const duplicate = page.getByRole("alert").filter({ hasText: "Kemungkinan pesanan dobel" });
  await expect(saved.or(duplicate)).toBeVisible();
  if (await duplicate.isVisible()) {
    await duplicate.getByLabel("Alasan pesanan tambahan").fill("Rit tambahan permintaan pelanggan (skenario E2E)");
    await duplicate.getByRole("button", { name: "Ini pesanan tambahan" }).click();
  }
  await expect(saved).toBeVisible();
  const number = (await saved.getByLabel("Nomor pesanan").textContent())!.trim();
  expect(number).toMatch(/^P-\d{2}-\d{6}$/);
  return number;
}

/**
 * Papan jadwal (US-M2-03): tugaskan rit dari "Belum terjadwal" ke truk, lalu terbitkan jalur truk itu. Unsur `orders`
 * berupa nomor pesanan (rit `…/1`) atau nomor rit lengkap (`P-YY-NNNNNN/2`).
 */
export async function assignAndPublish(page: Page, date: string, orders: string[], truck: string): Promise<void> {
  const tripOf = (o: string) => (o.includes("/") ? o : `${o}/1`);
  await page.goto(`/jadwal?tanggal=${date}`);
  await expect(page.getByRole("heading", { level: 1, name: "Papan jadwal" })).toBeVisible();
  const pending = page.getByRole("region", { name: "Belum terjadwal" });
  const lane = page.getByRole("region", { name: `Truk ${truck}` });
  for (const order of orders) {
    const tripNo = tripOf(order);
    const card = pending.getByRole("article", { name: `Rit ${tripNo}` });
    await expect(card).toBeVisible();
    const select = card.getByLabel(`Truk untuk ${tripNo}`);
    const option = select.locator("option", { hasText: new RegExp(`^${truck}\\b`) });
    await select.selectOption((await option.getAttribute("value"))!);
    await card.getByRole("button", { name: "Tugaskan" }).click();
    await expect(lane.getByRole("article", { name: `Rit ${tripNo}` })).toBeVisible();
  }
  await lane.getByRole("button", { name: "Terbitkan", exact: true }).click();
  for (const order of orders) await expect(lane.getByRole("article", { name: `Rit ${tripOf(order)}` }).getByText("Terbit", { exact: true })).toBeVisible();
}

/**
 * Sopir menjalankan satu rit dari rincian rit (bisa di luar urutan — konfirmasi diterima): Berangkat → Tiba → Selesai
 * (foto; untuk rit pelanggan juga penerima + tanda tangan). `pay` hanya untuk rit pelanggan.
 */
export async function runTripFromDetail(
  page: Page,
  opts: { tripNo: string; point: { latitude: number; longitude: number }; internal?: boolean; volumeL?: number; recipient?: string },
): Promise<void> {
  page.once("dialog", (d) => void d.accept());
  await moveTo(page, opts.point);
  const list = page.getByRole("region", { name: "Rit hari ini" });
  await list.getByTestId(`rit-${opts.tripNo}`).locator("[data-slot='field-list-item']").click();
  await page.getByRole("button", { name: "Berangkat" }).click();
  await page.getByRole("button", { name: "Tiba" }).click();
  await expect(page.getByRole("button", { name: "Tiba" })).toHaveCount(0);
  await page.getByRole("button", { name: "Selesai & bayar" }).click();
  await expect(page.getByTestId("langkah-bukti")).toBeVisible();
  await page.getByLabel("Foto bukti kirim", { exact: true }).setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: PHOTO });
  await expect(page.getByText(/Foto tersimpan/).first()).toBeVisible();
  if (!opts.internal) {
    await page.getByLabel("Nama penerima").fill(opts.recipient ?? "Penerima skenario");
    await signOnPad(page);
  }
  if (opts.volumeL !== undefined) await page.getByTestId("volume-terkirim").fill(String(opts.volumeL));
  await page.getByRole("button", { name: "Lanjut" }).click();
}

/** Minta sinkron sekarang di aplikasi lapangan (ketuk status sinkron: kirim antrean + tarik data terbaru). */
export async function syncNow(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Ketuk untuk kirim sekarang/ }).first().click();
}

/**
 * Admin Keuangan mencocokkan SEMUA transfer terbuka (Belum dicocokkan / Tidak ditemukan) pada rentang tanggal dengan
 * referensi mutasi internet banking (US-M4-04 KP-2, pencocokan manual). Mengembalikan jumlah transfer yang dicocokkan.
 */
export async function matchOpenTransfers(page: Page, opts: { from: string; to: string; note: string }): Promise<number> {
  let n = 0;
  for (; n < 40; n++) {
    await page.goto(`/kas/transfer?status=open&dari=${opts.from}&sampai=${opts.to}`);
    const row = page.getByTestId("daftar-transfer").getByRole("row").filter({ has: page.getByText("Cocokkan manual") }).first();
    if (!(await row.isVisible())) break;
    await row.getByText("Cocokkan manual").click();
    await row.getByLabel("Keterangan mutasi").fill(`TRSF E-BANKING CR ${n + 1} (${opts.note})`);
    await row.getByRole("button", { name: "Tandai cocok" }).click();
    await expect(page.getByText(/cocok/i).first()).toBeVisible();
  }
  return n;
}
