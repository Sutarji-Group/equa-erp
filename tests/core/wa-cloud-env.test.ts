import { afterEach, describe, expect, it } from "vitest";

import { parseServerEnv, resetServerEnvCache } from "@/lib/env";
import { cloudApiProvider, getWhatsAppProvider, waWebhookSecrets } from "@/server/core/wa";
import * as p2 from "@/server/modules/p2-customer";

const KEYS = ["WA_PROVIDER", "WA_CLOUD_TOKEN", "WA_CLOUD_PHONE_ID", "WA_WEBHOOK_VERIFY_TOKEN", "WA_APP_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  resetServerEnvCache();
}

describe("B-69 WhatsApp Cloud API lewat penyedia & env bersama (PTB-60, NFR-20)", () => {
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetServerEnvCache();
    p2.setCustomerWaProviderForTests(null);
  });

  it("B-69 US-P2-08 KP-1 getWhatsAppProvider: mode tautan bawaan; WA_PROVIDER=cloud_api → Cloud API yang sama untuk semua modul (P2 memakainya)", () => {
    setEnv({});
    expect(getWhatsAppProvider().kind).toBe("link");
    expect(p2.customerWaProvider().kind).toBe("link");
    setEnv({ WA_PROVIDER: "cloud_api", WA_CLOUD_TOKEN: "tok", WA_CLOUD_PHONE_ID: "123" });
    expect(getWhatsAppProvider().kind).toBe("cloud_api");
    expect(p2.customerWaProvider().kind).toBe("cloud_api");
    expect(p2.isAutoWaActive()).toBe(true);
  });

  it("B-69 penyedia inti mengirim TEMPLATE Meta (bahasa id, parameter body) atau teks; gagal → tautan cadangan", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls.length}` }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = cloudApiProvider({ token: "t", phoneNumberId: "p", fetchImpl });
    await provider.send({ to: "0812-3456-7890", text: "cadangan", kind: "order_confirmation", templateName: "equa_konfirmasi", variables: { nomor: "P-26-000001" } });
    await provider.send({ to: "0812-3456-7890", text: "Halo", kind: "trip_receipt" });
    expect(calls[0]).toMatchObject({ type: "template", template: { name: "equa_konfirmasi", language: { code: "id" } } });
    expect(JSON.stringify(calls[0])).toContain("P-26-000001");
    expect(calls[1]).toMatchObject({ type: "text", text: { body: "Halo" } });
  });

  it("B-69 rahasia webhook dibaca dari serverEnv(): verifikasi langganan & tanda tangan P2 memakai nilai tervalidasi", () => {
    setEnv({ WA_WEBHOOK_VERIFY_TOKEN: "verif-123", WA_APP_SECRET: "app-secret" });
    expect(waWebhookSecrets()).toEqual({ verifyToken: "verif-123", appSecret: "app-secret" });
    expect(p2.verifyWaWebhookChallenge({ mode: "subscribe", token: "verif-123", challenge: "42" })).toBe("42");
    expect(p2.verifyWaWebhookChallenge({ mode: "subscribe", token: "salah", challenge: "42" })).toBeNull();
    const raw = JSON.stringify({ object: "whatsapp_business_account" });
    expect(p2.verifyWaSignature(raw, p2.signWaWebhook(raw, "app-secret"))).toBe(true);
    expect(p2.verifyWaSignature(raw, p2.signWaWebhook(raw, "lain"))).toBe(false);
  });

  it("B-69 NFR-09 produksi dengan WA_PROVIDER=cloud_api wajib WA_APP_SECRET & WA_WEBHOOK_VERIFY_TOKEN (fail-closed); dev/uji tidak", () => {
    const prod = {
      VERCEL_ENV: "production",
      DB_DRIVER: "neon",
      DATABASE_URL: "postgres://u:p@h/db",
      SESSION_SECRET: "x".repeat(48),
      CRON_SECRET: "cron-prod",
      GPS_INGEST_TOKEN: "gps-prod",
      WA_PROVIDER: "cloud_api",
      WA_CLOUD_TOKEN: "tok",
      WA_CLOUD_PHONE_ID: "123",
    };
    expect(() => parseServerEnv(prod)).toThrow(/WA_APP_SECRET/);
    expect(() => parseServerEnv({ ...prod, WA_APP_SECRET: "s" })).toThrow(/WA_WEBHOOK_VERIFY_TOKEN/);
    expect(parseServerEnv({ ...prod, WA_APP_SECRET: "s", WA_WEBHOOK_VERIFY_TOKEN: "v" }).WA_APP_SECRET).toBe("s");
    expect(parseServerEnv({ WA_PROVIDER: "cloud_api", WA_CLOUD_TOKEN: "tok", WA_CLOUD_PHONE_ID: "123" }).WA_PROVIDER).toBe("cloud_api");
  });
});
