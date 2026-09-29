import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { seedId } from "../src/db/seed/ids";

/** Akun demo seed (src/db/seed/constants.ts). */
const PASSWORD = "equa-demo-2026";
const ADMIN_TOTP = "EQUADEMOADMINSATURAHASIATOTPAAAA";
const PIN = "123456";
/** Tablet POS depot D02 (seed) & operatornya (depot02). */
const POS_DEVICE_ID = seedId("device:POS-D02");
const OPERATOR = "Imas Masitoh";

async function loginAdmin(page: Page): Promise<void> {
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill("admin1");
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/masuk\/2fa$/);
  // Kode TOTP yang baru dipakai spesifikasi lain ditolak (anti-replay) → tunggu langkah waktu berikutnya.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret: ADMIN_TOTP }));
    await page.getByRole("button", { name: "Verifikasi" }).click();
    const ok = await page
      .waitForURL(/\/beranda/, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  }
  throw new Error("Gagal masuk sebagai admin1");
}

/** Teks rupiah terformat (`formatRupiah` memakai spasi tak putus setelah "Rp"). */
function rp(amount: string): RegExp {
  return new RegExp(`Rp\\s?${amount.replace(".", "\\.")}`);
}

function digits(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9]/g, ""));
}

test.describe("M6 — POS depot di tablet (offline-first)", () => {
  test.setTimeout(240_000);
  test("B-03 US-M10-07 KP-3 US-M6-01 KP-1/KP-2 US-M6-02 KP-1/KP-3 US-M6-03 KP-1 US-M6-06 KP-1/KP-2 aktivasi tablet POS → PIN → buka shift → jual tunai → jual QRIS saat offline → terkirim → void + pengganti → tutup shift → serah setoran", async ({
    page,
    context,
  }) => {
    // Admin sistem menerbitkan kode aktivasi tablet POS D02 (M10).
    await loginAdmin(page);
    await page.goto(`/akses/perangkat/${POS_DEVICE_ID}`);
    await page.getByText("Terbitkan kode aktivasi baru").click();
    await page.getByLabel("Alasan").last().fill("Tablet POS dipasang ulang (uji E2E)");
    await page.getByRole("button", { name: "Terbitkan kode" }).click();
    const code = (await page.getByTestId("kode-sekali").textContent())!.trim();
    expect(code.length).toBeGreaterThanOrEqual(6);
    await context.clearCookies();

    // Aktivasi tablet → aplikasi POS → operator + PIN.
    await page.goto("/aktivasi-perangkat");
    await page.getByLabel("Kode aktivasi").fill(code);
    await page.getByRole("button", { name: "Aktifkan" }).click();
    await expect(page).toHaveURL(/\/pos$/);
    await page.getByRole("button", { name: new RegExp(OPERATOR) }).click();
    for (const digit of PIN) await page.getByRole("button", { name: digit, exact: true }).click();

    // Buka shift: kas awal tetap dari sistem (PAR-57 Rp200.000), stok awal bahan dari seed demo.
    const open = page.getByTestId("buka-shift");
    await expect(open).toBeVisible({ timeout: 30_000 });
    await expect(open).toContainText(rp("200.000"));
    await expect(open).toContainText("Tutup galon");
    await open.getByRole("button", { name: "Buka shift" }).click();

    // Jual tunai: ketuk produk (harga dari master), uang pas → struk.
    await page.getByRole("button", { name: /^Isi ulang galon 19 L, Rp\s?5\.000/ }).click();
    await page.getByRole("button", { name: /^Isi ulang galon 19 L, Rp\s?5\.000/ }).click();
    await page.getByRole("button", { name: "Simpan · Tunai" }).click();
    const receipt = page.getByTestId("struk");
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText(rp("10.000"));
    await page.getByRole("button", { name: "Transaksi baru" }).click();
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // Sinyal hilang: transaksi QRIS tetap tersimpan di tablet dengan nomor lokal.
    await context.setOffline(true);
    await expect(page.getByText("Sinyal hilang — data tersimpan di ponsel, lanjutkan bekerja.")).toBeVisible();
    await page.getByRole("button", { name: /^Isi ulang galon 19 L, Rp\s?5\.000/ }).click();
    await page.getByRole("radio", { name: "QRIS" }).click();
    await page.getByRole("button", { name: "QRIS diterima · Simpan" }).click();
    await expect(page.getByTestId("struk")).toContainText("Tersimpan di perangkat");
    await expect(page.getByTestId("nomor-transaksi")).toContainText(/D02-\d{6}-POSD02-\d{4}/);
    await expect(page.getByText(/Tersimpan di ponsel: \d+/).first()).toBeVisible();
    await page.getByRole("button", { name: "Transaksi baru" }).click();

    // Sinyal kembali → terkirim otomatis; nomor resmi terbit saat sinkron.
    await context.setOffline(false);
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // Void transaksi QRIS dalam shift (alasan wajib, di bawah PAR-04 → langsung void; Admin Keuangan diberi tahu).
    await page.getByRole("button", { name: "Shift & void" }).click();
    const qrisSale = page.getByRole("list", { name: "Transaksi shift" }).locator("li", { hasText: "QRIS" }).first();
    await qrisSale.getByRole("button", { name: "Void…" }).click();
    await qrisSale.getByRole("radio", { name: "Salah cara bayar" }).click();
    await qrisSale.getByRole("button", { name: "Void transaksi ini" }).click();
    await expect(page.getByText("Transaksi di-void.")).toBeVisible();
    // Transaksi pengganti: keranjang terisi dari transaksi yang di-void, dibayar tunai.
    await page.getByRole("button", { name: "Buat transaksi pengganti" }).click();
    await expect(page.getByText("Transaksi pengganti untuk transaksi yang di-void.")).toBeVisible();
    await page.getByRole("button", { name: "Simpan · Tunai" }).click();
    await expect(page.getByTestId("struk")).toContainText(rp("5.000"));
    await page.getByRole("button", { name: "Transaksi baru" }).click();
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Shift & void" }).click();

    // Tutup shift: kas fisik = tunai seharusnya, stok fisik = stok seharusnya.
    const close = page.getByTestId("tutup-shift");
    const expected = digits(await close.getByTestId("tunai-seharusnya").textContent());
    expect(expected).toBe(215_000);
    await close.getByLabel("Kas fisik di laci (hitung)").fill(String(expected));
    for (const name of ["Tutup galon", "Tisu segel galon", "Galon kosong 19 L (bahan)"]) {
      const label = close.locator("label", { hasText: `${name} (fisik)` });
      const text = await label.textContent();
      const should = Number(/stok seharusnya (-?\d+)/.exec(text ?? "")?.[1] ?? "0");
      await label.locator("input").fill(String(should));
    }
    await close.getByRole("button", { name: "Tutup shift" }).click();

    // Serah setoran shift (US-M6-02 KP-5): jumlah disetor = tunai seharusnya − kas awal tetap.
    const handover = page.getByTestId("serah-setoran");
    await expect(handover).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });
    await expect(handover).toContainText(rp("15.000"));
    await handover.getByRole("button", { name: "Tandai sudah disetor" }).click();
    await expect(handover).toContainText("Setoran ditandai Disetor");
    await expect(page.getByText("Semua terkirim")).toBeVisible({ timeout: 30_000 });

    // B-03 (US-M10-07 KP-3): menu Bantuan POS — laporan kendala aplikasi (antrean offline) & status sinkron.
    await page.getByRole("navigation", { name: "Menu POS" }).getByRole("button", { name: "Bantuan" }).click();
    const help = page.getByTestId("bantuan-pos");
    await expect(help).toContainText("Laporkan kendala aplikasi");
    await expect(help).toContainText("Semua data sudah terkirim.");
  });
});
