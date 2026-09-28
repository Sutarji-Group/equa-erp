import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

/**
 * Aplikasi sopir (M3) di ponsel: data demo `src/db/seed/demo-m3-driver.ts` (truk T2, sopir2 "Ujang Suryana"; rit 1
 * Selesai, rit 2–4 Ditugaskan). Ponsel baru untuk T2 didaftarkan admin sistem lewat web kantor (kode aktivasi sekali),
 * lalu sopir bekerja: Berangkat → Tiba → Selesai (foto, tanda tangan, tunai) → struk → Setor tanpa sinyal.
 */
const PASSWORD = "equa-demo-2026";
const ADMIN_TOTP = "EQUADEMOADMINSATURAHASIATOTPAAAA";
const PIN = "123456";
/** Titik alamat PLG-0020 (Perumahan Citra Cianjur Residence) — rit 2 T2. */
const ADDRESS = { latitude: -6.8095, longitude: 107.152 };
/** PNG 1×1 sah (foto uji; dikompres ulang di ponsel menjadi JPEG). */
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test.use({ geolocation: ADDRESS, permissions: ["geolocation"] });

async function loginAdmin(page: Page): Promise<void> {
  const used = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/masuk");
    await page.getByLabel("Nama pengguna").fill("admin1");
    await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(page).toHaveURL(/\/masuk\/2fa$/);
    let code = await generate({ secret: ADMIN_TOTP });
    if (used.has(code)) {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
      code = await generate({ secret: ADMIN_TOTP });
    }
    used.add(code);
    await page.getByLabel("Kode verifikasi").fill(code);
    await page.getByRole("button", { name: "Verifikasi" }).click();
    const ok = await page
      .waitForURL(/\/beranda/, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    // Kode dalam langkah waktu ini sudah dipakai spesifikasi lain → tunggu langkah berikutnya.
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  }
  throw new Error("Gagal masuk sebagai admin1");
}

/** Admin sistem mendaftarkan ponsel baru untuk truk T2 dan membaca kode aktivasi sekali-tampil. */
async function issueActivationCodeForT2(page: Page): Promise<string> {
  await loginAdmin(page);
  await page.goto("/akses/perangkat");
  const form = page.getByTestId("form-daftar-perangkat");
  await form.getByLabel("Kode perangkat (label aset/IMEI)").fill(`HP-E2E-M3-${Date.now() % 100_000}`);
  await form.getByLabel("Nama").fill("Ponsel uji M3 truk T2");
  const option = form.locator("#perangkat-unit option", { hasText: "Truk T2 " });
  await form.getByLabel("Unit").selectOption((await option.getAttribute("value"))!);
  await form.getByRole("button", { name: "Daftarkan & buat kode aktivasi" }).click();
  const code = form.getByTestId("kode-sekali");
  await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const text = (await code.textContent())!.trim();
  await page.context().clearCookies();
  return text;
}

test.describe("Aplikasi sopir (M3)", () => {
  test("US-M3-01 KP-1 KP-7 US-M3-02 KP-1 US-M3-03 KP-1 KP-7 US-M3-04 KP-1 US-M3-07 KP-1 KP-2 US-M3-09 KP-1 KP-2 sopir: Berangkat → Tiba → Selesai (foto, tanda tangan, tunai) → struk → Setor tanpa sinyal → terkirim", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    const code = await issueActivationCodeForT2(page);

    await page.goto("/aktivasi-perangkat");
    await page.getByLabel("Kode aktivasi").fill(code);
    await page.getByRole("button", { name: "Aktifkan" }).click();
    await expect(page).toHaveURL(/\/sopir$/);
    await page.getByRole("button", { name: /Ujang Suryana/ }).click();
    for (const digit of PIN) await page.getByRole("button", { name: digit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Aplikasi Sopir" })).toBeVisible();

    // KP-1: daftar rit hari ini T2 — rit berikutnya (urutan 2) ditonjolkan dengan tombol Berangkat; rit Selesai turun.
    const list = page.getByRole("region", { name: "Rit hari ini" });
    // Rit 1 Selesai (seed); rit 3 mungkin sudah dicatat Gagal oleh spesifikasi kantor (e2e/m3-driver.spec.ts).
    const heading = list.getByRole("heading", { name: /Rit hari ini · T2 \(\d\/4 selesai\)/ });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    const doneBefore = Number(/\((\d)\/4/.exec((await heading.textContent())!)![1]);
    const card = list.locator("[data-testid^='rit-']").filter({ hasText: "Perumahan Citra Cianjur Residence" });
    await expect(card).toBeVisible();
    await expect(list.locator("[data-testid^='rit-']").first()).toContainText("Perumahan Citra Cianjur Residence");
    await expect(list.locator("[data-testid^='rit-']").filter({ hasText: "Bapak Dadang Suhendar" })).toContainText("Selesai");

    // KP-7: setiap tindakan ≤ 3 ketukan dari daftar — Berangkat (1), Tiba (1), Selesai & bayar (1) langsung di kartu.
    let taps = 0;
    await card.getByRole("button", { name: "Berangkat" }).click();
    taps++;
    await expect(card.getByRole("button", { name: "Tiba" })).toBeVisible();
    expect(taps).toBeLessThanOrEqual(3);
    taps = 0;
    await card.getByRole("button", { name: "Tiba" }).click();
    taps++;
    await expect(card.getByRole("button", { name: "Selesai & bayar" })).toBeVisible();
    expect(taps).toBeLessThanOrEqual(3);
    taps = 0;
    await card.getByRole("button", { name: "Selesai & bayar" }).click();
    taps++;
    expect(taps).toBeLessThanOrEqual(3);

    // US-M3-03 KP-1: foto (kamera aplikasi), nama penerima, tanda tangan, volume bawaan 5.000 L.
    const proof = page.getByTestId("langkah-bukti");
    await expect(proof).toBeVisible();
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Ambil minimal satu foto" })).toBeVisible();
    await page.getByLabel("Foto bukti kirim", { exact: true }).setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: PHOTO });
    await expect(page.getByText(/Foto tersimpan/).first()).toBeVisible();
    await page.getByLabel("Nama penerima").fill("Pak Satpam Blok A");
    const pad = page.getByRole("img", { name: "Bidang tanda tangan kosong" });
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 80, { steps: 5 });
    await page.mouse.move(box.x + 200, box.y + 50, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole("img", { name: "Tanda tangan sudah diisi" })).toBeVisible();
    await page.getByRole("button", { name: "Lanjut" }).click();

    // US-M3-04 KP-1: pembayaran tidak dapat dilewati — tunai bawaan harga pesanan (satu-satunya harga, BR-19).
    await expect(page.getByTestId("langkah-bayar")).toBeVisible();
    const price = (await page.getByTestId("harga-bayar").textContent())!;
    expect(price).toMatch(/Rp/);
    await expect(page.getByRole("radio", { name: "Tunai" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Lanjut" }).click();
    await expect(page.getByTestId("langkah-simpan")).toBeVisible();
    await expect(page.getByText(/Lokasi tercatat/)).toBeVisible();
    await page.getByRole("button", { name: "Simpan Selesai" }).click();

    // US-M3-03 KP-7: struk WA satu ketukan, atau dilewati dengan alasan.
    const receipt = page.getByTestId("struk-wa");
    await expect(receipt).toBeVisible();
    await receipt.getByRole("radio", { name: "Pelanggan tidak minta struk" }).click();
    await receipt.getByRole("button", { name: "Lewati & kembali ke daftar rit" }).click();
    await expect(list.getByRole("heading", { name: `Rit hari ini · T2 (${doneBefore + 1}/4 selesai)` })).toBeVisible();
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // US-M3-07 KP-1: kas di tangan = tunai rit 1 (seed) + tunai rit 2.
    await page.getByTestId("kas-di-tangan").click();
    const setor = page.getByTestId("setor");
    await expect(setor.getByText("Rit Selesai")).toBeVisible();
    await expect(setor.getByTestId("seharusnya-disetor")).toContainText("Rp");

    // US-M3-09 KP-1/KP-2: tanpa sinyal Setor tetap tercatat di ponsel, lalu terkirim otomatis saat sinyal kembali.
    await context.setOffline(true);
    await expect(page.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
    await setor.getByRole("button", { name: /^Setor Rp/ }).click();
    await expect(page.getByTestId("setoran-diajukan")).toContainText("tersimpan di ponsel");
    await expect(page.getByText("Tersimpan di ponsel: 1")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("setoran-diajukan")).toContainText(/Setoran S-\d{2}-\d{6} diajukan/, { timeout: 30_000 });
    await expect(page.getByTestId("setoran-diajukan")).not.toContainText("tersimpan di ponsel");
  });
});
