import { expect, test } from "@playwright/test";

test.describe("Smoke scaffold (Sprint 0)", () => {
  test("akar situs mengarah ke halaman masuk berbahasa Indonesia", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/masuk$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "id");
    await expect(page.getByLabel("Nama pengguna")).toBeVisible();
    await expect(page.getByLabel("Kata sandi")).toBeVisible();
    await expect(page.getByRole("button", { name: "Masuk" })).toBeVisible();
  });

  test("endpoint kesehatan merespons", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("cron tick menolak tanpa CRON_SECRET", async ({ request }) => {
    const res = await request.get("/api/cron/tick");
    expect(res.status()).toBe(401);
  });

  test("halaman tidak dikenal menampilkan 404 Indonesia", async ({ page }) => {
    const res = await page.goto("/tidak-ada");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Halaman tidak ditemukan" })).toBeVisible();
  });
});
