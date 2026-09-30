import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

import { allNavItems } from "../src/components/shared/nav/registry";

/** M9 — H+0 & kotak masuk terbaca di ponsel pemilik tanpa gulir mendatar (US-M9-01 KP-5, NFR-19). */

const PASSWORD = "equa-demo-2026";
const TOTP_PEMILIK = "EQUADEMOPEMILIKRAHASIATOTPDEVAAA";

async function loginOwner(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/masuk");
  await page.getByLabel("Nama pengguna").fill("pemilik");
  await page.getByLabel("Kata sandi", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/\/masuk\/2fa$/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByLabel("Kode verifikasi").fill(await generate({ secret: TOTP_PEMILIK }));
    await page.getByRole("button", { name: "Verifikasi" }).click();
    const ok = await page
      .waitForURL(/\/beranda/, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  }
  throw new Error("Gagal masuk sebagai pemilik");
}

/**
 * NFR-19: bandingkan dengan lebar VIEWPORT tetap (bukan `window.innerWidth` — pada emulasi ponsel ikut melebar mengikuti
 * konten sehingga asersi lama selalu lulus).
 */
async function expectNoHorizontalScroll(page: Page, what = page.url()): Promise<void> {
  const viewport = page.viewportSize()!.width;
  const scrollWidth = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
  expect(scrollWidth, `${what}: lebar halaman ${scrollWidth}px > layar ${viewport}px`).toBeLessThanOrEqual(viewport + 1);
}

test("US-M9-01 KP-5 H+0, laporan bulanan & kotak masuk terbaca di ponsel pemilik tanpa gulir mendatar; muat ≤ 2 detik (dihitung server)", async ({ page }) => {
  test.setTimeout(180_000);
  await loginOwner(page);
  await page.goto("/laporan/hari-ini");
  await expect(page.getByTestId("h0-revenue")).toBeVisible();
  await expectNoHorizontalScroll(page);
  const ms = Number((await page.getByText(/Dihitung \d+ ms/).textContent())?.match(/(\d+) ms/)?.[1] ?? "99999");
  expect(ms).toBeLessThan(2_000);
  await page.goto("/laporan/hari-ini?rentang=last7");
  await expect(page.getByTestId("h0-trips")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto("/kotak-masuk");
  await expect(page.getByTestId("inbox-page")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto("/laporan/bulanan");
  await expect(page.getByTestId("monthly-lines")).toBeVisible();
  await expectNoHorizontalScroll(page);
});

/**
 * Semua rute menu web kantor (registri navigasi, tanpa halaman rincian/dinamis) — dibuka pemilik di ponsel. Temuan audit
 * S5-B: halaman melebar karena tabel di dalam kartu yang menjadi anak grid (`min-width: auto`).
 */
const OWNER_MOBILE_ROUTES = allNavItems()
  .filter((item) => !item.hidden && !item.href.includes("["))
  .map((item) => item.href);

test("NFR-19 US-M9-01 KP-5 semua halaman menu kantor di ponsel pemilik tidak melebar melewati layar (tabel menggulir di dalam kartu)", async ({ page }) => {
  test.setTimeout(600_000);
  await loginOwner(page);
  const viewport = page.viewportSize()!.width;
  const failures: string[] = [];
  for (const route of OWNER_MOBILE_ROUTES) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
    const width = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    if (width > viewport + 1) failures.push(`${route}: ${width}px`);
  }
  expect(failures, `Halaman melebar melewati ${viewport}px`).toEqual([]);
});
