import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/** Akun demo seed (src/db/seed/constants.ts). Dispatcher tanpa 2FA; pemilik & Admin Keuangan wajib TOTP (PTB-35). */
const PASSWORD = "equa-demo-2026";
const TOTP: Record<string, string> = {
  pemilik: "EQUADEMOPEMILIKRAHASIATOTPDEVAAA",
  keuangan1: "EQUADEMOKEUANGANSATURAHASIATOTPA",
};
/** Token penghubung GPS bawaan dev (E2E `next start` memakai ALLOW_DEV_SECRETS=1). */
const GPS_TOKEN = process.env.GPS_INGEST_TOKEN ?? "dev-gps-ingest-token";

async function login(page: Page, username: string) {
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill(username);
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  const secret = TOTP[username];
  if (secret) {
    await expect(page).toHaveURL(/\/masuk\/2fa$/);
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret }));
    await page.getByRole("button", { name: "Verifikasi" }).click();
    const rejected = page.getByText(/Kode verifikasi salah/);
    const outcome = await Promise.race([
      page.waitForURL(/\/beranda$/, { timeout: 10_000 }).then(() => "ok" as const, () => "timeout" as const),
      rejected.waitFor({ state: "visible", timeout: 10_000 }).then(() => "rejected" as const, () => "timeout" as const),
    ]);
    if (outcome === "rejected") {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
      await page.getByLabel("Kode verifikasi").fill(await generate({ secret }));
      await page.getByRole("button", { name: "Verifikasi" }).click();
    }
  }
  await expect(page).toHaveURL(/\/beranda$/);
}

/** Tanggal bisnis WIB `YYYY-MM-DD` + n hari. */
function wibDate(plusDays: number): string {
  return new Date(Date.now() + 7 * 3_600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
}

test.describe.serial("Pelacakan armada / GPS (M12)", () => {
  test("US-M12-01 KP-1 KP-3 penghubung vendor menerima posisi (token wajib, JSON generik & OsmAnd); kirim ulang tidak menggandakan", async ({ request }) => {
    const now = Date.now();
    const positions = [3, 2, 1, 0].map((m) => ({ deviceId: "GPS-T1", time: new Date(now - m * 60_000).toISOString(), lat: -6.8121 + m * 0.002, lng: 107.1605, speedKmh: 30, heading: 180, accuracyM: 8, power: true }));
    const denied = await request.post("/api/gps/ingest/generic-json", { data: { positions } });
    expect(denied.status()).toBe(401);
    const ok = await request.post("/api/gps/ingest/generic-json", { data: { positions }, headers: { authorization: `Bearer ${GPS_TOKEN}` } });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toMatchObject({ accepted: 4, duplicates: 0 });
    const again = await request.post("/api/gps/ingest/generic-json", { data: { positions }, headers: { authorization: `Bearer ${GPS_TOKEN}` } });
    expect(await again.json()).toMatchObject({ accepted: 0, duplicates: 4 });
    const osmand = await request.get(`/api/gps/ingest/osmand?id=GPS-T3&lat=-6.8301&lon=107.1502&timestamp=${Math.floor(now / 1000)}&speed=10&token=${GPS_TOKEN}`);
    expect(osmand.status()).toBe(200);
    expect((await request.get("/api/gps/ingest/vendor-x", { headers: { authorization: `Bearer ${GPS_TOKEN}` } })).status()).toBe(404);
  });

  test("US-M12-02 KP-1 KP-2 KP-3 dispatcher melihat peta truk: status, umur posisi, rincian truk (rit, kontak, riwayat), lapisan peta; tersemat di papan jadwal", async ({ page }) => {
    await login(page, "dispatcher1");
    await page.goto("/armada/peta");
    await expect(page.getByRole("heading", { level: 1, name: "Peta truk" })).toBeVisible();
    const map = page.getByTestId("fleet-live-map");
    await expect(map).toBeVisible();
    await expect(map.getByRole("region", { name: "Peta posisi truk" })).toBeVisible();
    for (const layer of ["Alamat rit hari ini", "Sumber air", "Depot", "Pool", "Zona tarif"]) await expect(map.getByLabel(layer)).toBeVisible();
    const t1 = map.getByTestId("truk-T1");
    await expect(t1).toBeVisible();
    await expect(t1).toContainText(/km\/jam/);
    await t1.click();
    const detail = page.getByTestId("rincian-truk");
    await expect(detail).toContainText("T1");
    await expect(detail).toContainText("Rit hari ini");
    await expect(detail.getByRole("link", { name: "Riwayat hari ini" })).toBeVisible();
    await expect(map.getByTestId("truk-T7")).toContainText("GPS ponsel");

    const live = await page.request.get("/api/gps/live");
    expect(live.status()).toBe(200);
    const body = (await live.json()) as { snapshot: { trucks: { code: string }[]; refreshSeconds: number } };
    expect(body.snapshot.refreshSeconds).toBeLessThanOrEqual(60);
    expect(body.snapshot.trucks.map((t) => t.code)).toEqual(expect.arrayContaining(["T1", "T2", "T3", "T4", "T5", "T6", "T7"]));

    await page.goto("/jadwal");
    await expect(page.getByRole("region", { name: "Peta truk real-time" })).toBeVisible();
  });

  test("US-M12-03 KP-1 KP-2 KP-3 riwayat per truk per hari & per rit (jarak, titik berhenti, ekspor)", async ({ page }) => {
    const yesterday = wibDate(-1);
    await login(page, "dispatcher1");
    await page.goto(`/armada/riwayat?tanggal=${yesterday}`);
    await expect(page.getByRole("heading", { level: 1, name: "Riwayat perjalanan" })).toBeVisible();
    const perTruck = page.getByTestId("riwayat-truk");
    await expect(perTruck).toContainText("T4");
    await expect(page.getByRole("link", { name: "Excel titik berhenti" })).toBeVisible();
    await perTruck.getByRole("link", { name: "T4", exact: true }).click();
    await expect(page).toHaveURL(/\/armada\/riwayat\/truk\/[0-9a-f-]{36}\?tanggal=/);
    await expect(page.getByRole("heading", { level: 1, name: /Truk T4/ })).toBeVisible();
    await expect(page.getByText("Jarak total")).toBeVisible();
    await expect(page.getByText("Perjalanan di luar jadwal").first()).toBeVisible();
  });

  test("US-M12-08 KP-1 KP-3 KP-4 halaman perangkat GPS: status Dicabut, GPS ponsel cadangan, pola per truk", async ({ page }) => {
    await login(page, "dispatcher1");
    await page.goto("/armada/perangkat");
    await expect(page.getByRole("heading", { level: 1, name: "Perangkat GPS" })).toBeVisible();
    const table = page.getByTestId("perangkat-gps");
    await expect(table.getByRole("row", { name: /GPS-T7/ })).toContainText("Dicabut");
    await expect(table.getByRole("row", { name: /GPS-T7/ })).toContainText("GPS ponsel");
    await expect(page.getByTestId("pola-perangkat")).toContainText("T6");
  });

  test("US-M12-05 KP-3 KP-4 US-M12-04 KP-3 pemilik meninjau kejadian (keterangan sopir) dan menerima alasan — berjejak", async ({ page }) => {
    await login(page, "pemilik");
    await page.goto("/armada/kejadian");
    await expect(page.getByRole("heading", { level: 1, name: "Kejadian armada" })).toBeVisible();
    const list = page.getByTestId("daftar-kejadian");
    const item = list.locator("li", { hasText: "tambal ban" }).first();
    await expect(item).toContainText("Perjalanan di luar jadwal");
    await item.getByRole("link", { name: "Rincian & peta" }).click();
    await expect(page).toHaveURL(/\/armada\/kejadian\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Perjalanan di luar jadwal" })).toBeVisible();
    await expect(page.getByText(/tambal ban/)).toBeVisible();
    const accept = page.getByTestId("aksi-terima");
    await accept.getByLabel("Catatan (opsional)").fill("Sudah dikonfirmasi Dispatcher.");
    await accept.getByRole("button", { name: "Terima alasan" }).click();
    await expect(page.getByTestId("aksi-terima")).toHaveCount(0);
    await expect(page.getByText("Ditinjau", { exact: true })).toBeVisible();

    await page.goto("/armada/kejadian?tampil=h0");
    await expect(page.getByTestId("ringkasan-h0")).toBeVisible();
    await page.goto("/armada/bbm");
    await expect(page.getByText("Konsumsi & harga BBM belum ditetapkan")).toBeVisible();
  });

  test("US-M12-02 KP-4 peran lain (Admin Keuangan) tidak mendapat data posisi; tanpa masuk ditolak", async ({ page, request }) => {
    expect((await request.get("/api/gps/live")).status()).toBe(401);
    await login(page, "keuangan1");
    const res = await page.request.get("/api/gps/live");
    expect(res.status()).toBe(403);
    await page.goto("/armada/peta");
    await expect(page).toHaveURL(/\/beranda\?ditolak=1$/);
  });
});
