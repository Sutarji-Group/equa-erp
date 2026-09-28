import { expect, test, type Page } from "@playwright/test";

/** Akun demo seed (src/db/seed/constants.ts). Dispatcher tanpa 2FA. */
const PASSWORD = "equa-demo-2026";

async function login(page: Page, username: string) {
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill(username);
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/beranda$/);
}

/** Tanggal bisnis WIB `YYYY-MM-DD` + n hari. */
function wibDate(plusDays: number): string {
  return new Date(Date.now() + 7 * 3_600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
}

// Satu alur berkesinambungan: pesanan dibuat → dijadwalkan & diterbitkan → dibatalkan beralasan.
test.describe.serial("Pesanan & penjadwalan rit (M2)", () => {
  const date = wibDate(2);
  let orderNumber = "";
  let orderUrl = "";

  test("US-M2-01 KP-1 KP-2 KP-3 KP-7 KP-8 US-M2-02 KP-1 dispatcher membuat pesanan di satu layar dan melihat nomor besar", async ({ page }) => {
    await login(page, "dispatcher1");
    await page.goto("/pesanan/baru");
    await expect(page.getByRole("heading", { level: 1, name: "Pesanan baru" })).toBeVisible();
    const started = Date.now();

    // Cari pelanggan (nama/WA/alamat) → alamat terakhir & harga otomatis.
    await page.locator("#f-customer").click();
    await page.getByPlaceholder("Ketik minimal 2 karakter").fill("Ujang Rahmat");
    await page.getByRole("option", { name: /Bapak Ujang Rahmat/ }).click();
    await expect(page.locator("#f-customer")).toContainText("Bapak Ujang Rahmat");
    await expect(page.getByRole("radio", { checked: true })).toBeVisible();

    await page.locator("#f-tankCount").fill("2");
    await page.locator("#f-requestedDate").fill(date);
    await expect(page.getByTestId("harga-pesanan")).toContainText("Rp");
    await page.getByRole("button", { name: "Simpan pesanan" }).click();

    const saved = page.getByTestId("pesanan-tersimpan");
    await expect(saved).toBeVisible();
    const number = saved.getByLabel("Nomor pesanan");
    await expect(number).toHaveText(/^P-\d{2}-\d{6}$/);
    orderNumber = (await number.textContent())!.trim();
    await expect(saved).toContainText("2 tangki");
    // KP-7 (proksi otomatis): pesanan tersimpan jauh di bawah 60 detik sejak layar dibuka.
    expect(Date.now() - started).toBeLessThan(60_000);
    await expect(saved.getByRole("button", { name: "Kirim konfirmasi WA" })).toBeVisible();

    await saved.getByRole("link", { name: "Lihat rincian" }).click();
    await expect(page).toHaveURL(/\/pesanan\/[0-9a-f-]{36}$/);
    orderUrl = page.url();
    await expect(page.getByRole("heading", { level: 1, name: orderNumber })).toBeVisible();
    await expect(page.getByText("Baru", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel(`Rit ${orderNumber}/2`).or(page.getByText(`${orderNumber}/2`)).first()).toBeVisible();
  });

  test("US-M2-03 KP-2 KP-5 rit dari kolom Belum terjadwal ditugaskan ke truk lalu jadwal diterbitkan", async ({ page }) => {
    test.skip(!orderNumber, "butuh pesanan dari langkah sebelumnya");
    await login(page, "dispatcher1");
    await page.goto(`/jadwal?tanggal=${date}`);
    await expect(page.getByRole("heading", { level: 1, name: "Papan jadwal" })).toBeVisible();

    const tripNo = `${orderNumber}/1`;
    const pending = page.getByRole("region", { name: "Belum terjadwal" });
    const card = pending.getByRole("article", { name: `Rit ${tripNo}` });
    await expect(card).toBeVisible();
    const select = card.getByLabel(`Truk untuk ${tripNo}`);
    const option = select.locator("option").nth(1);
    const truckCode = ((await option.textContent()) ?? "").split(" ")[0];
    expect(truckCode).toMatch(/^T\d$/);
    await select.selectOption((await option.getAttribute("value"))!);
    await card.getByRole("button", { name: "Tugaskan" }).click();

    const lane = page.getByRole("region", { name: `Truk ${truckCode}` });
    const assigned = lane.getByRole("article", { name: `Rit ${tripNo}` });
    await expect(assigned).toBeVisible();
    await expect(assigned).toContainText("Ditugaskan");

    await lane.getByRole("button", { name: "Terbitkan", exact: true }).click();
    await expect(assigned.getByText("Terbit", { exact: true })).toBeVisible();
    // Rit ke-2 pesanan yang sama tetap di Belum terjadwal (n tangki = n rit).
    await expect(pending.getByRole("article", { name: `Rit ${orderNumber}/2` })).toBeVisible();
  });

  test("US-M2-02 KP-3 KP-4 pesanan dibatalkan dengan alasan dari daftar; rit ditarik dari papan; pencarian nomor", async ({ page }) => {
    test.skip(!orderUrl, "butuh pesanan dari langkah pertama");
    await login(page, "dispatcher1");
    await page.goto(orderUrl);
    await page.getByRole("button", { name: "Batalkan pesanan" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Pelanggan batal").check();
    await dialog.getByRole("button", { name: "Batalkan pesanan" }).click();
    await expect(page.getByText("Dibatalkan", { exact: true }).first()).toBeVisible();

    await page.goto(`/jadwal?tanggal=${date}`);
    await expect(page.getByRole("heading", { level: 1, name: "Papan jadwal" })).toBeVisible();
    await expect(page.getByRole("article", { name: `Rit ${orderNumber}/1` })).toHaveCount(0);
    await expect(page.getByRole("article", { name: `Rit ${orderNumber}/2` })).toHaveCount(0);

    // KP-4: cari berdasarkan nomor + saring status.
    await page.goto(`/pesanan?q=${encodeURIComponent(orderNumber)}&status=cancelled`);
    await expect(page.getByRole("heading", { level: 1, name: "Pesanan", exact: true })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: orderNumber }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Dibatalkan");

    // Layar M2 lain terbuka dan berisi data demo (seed).
    await page.goto("/jadwal/kru");
    await expect(page.getByRole("heading", { level: 1, name: "Jadwal kru" })).toBeVisible();
    await page.goto("/langganan");
    await expect(page.getByRole("heading", { level: 1, name: "Pesanan berulang" })).toBeVisible();
    await expect(page.getByText("Hotel", { exact: false }).first()).toBeVisible();
  });
});
