import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";

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

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
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
