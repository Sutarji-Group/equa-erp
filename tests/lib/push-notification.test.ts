import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildPushNotification, safeNotificationPath } from "@/lib/push-notification";

const ORIGIN = "https://equa.example";

describe("B-68 Web Push di service worker (PTB-05, US-P2-03 KP-4)", () => {
  it("B-68 US-P2-03 KP-4 muatan server {title, body, url, tag, severity} → notifikasi perangkat; kritis tetap tampil", () => {
    const n = buildPushNotification(JSON.stringify({ title: "Truk berangkat", body: "Rit P-26-000001/1 menuju alamat Anda", url: "/app/pesanan/abc?tab=status", tag: "order:abc", severity: "normal" }), ORIGIN);
    expect(n.title).toBe("Truk berangkat");
    expect(n.options).toMatchObject({ body: "Rit P-26-000001/1 menuju alamat Anda", tag: "order:abc", lang: "id", requireInteraction: false, data: { url: "/app/pesanan/abc?tab=status" } });
    expect(n.options.icon).toBe("/icons/icon-192.png");
    const critical = buildPushNotification(JSON.stringify({ title: "Sinkron gagal massal", severity: "critical", url: "/akses/sinkron" }), ORIGIN);
    expect(critical.options.requireInteraction).toBe(true);
    expect(critical.options.data.url).toBe("/akses/sinkron");
  });

  it("B-68 muatan kosong/rusak tetap menampilkan notifikasi bawaan; teks biasa menjadi isi pesan", () => {
    expect(buildPushNotification(null, ORIGIN)).toMatchObject({ title: "EQUA", options: { data: { url: "/" } } });
    expect(buildPushNotification("Pesan singkat", ORIGIN)).toMatchObject({ title: "EQUA", options: { body: "Pesan singkat" } });
    expect(buildPushNotification(JSON.stringify({ title: "  ", body: 5 }), ORIGIN).title).toBe("EQUA");
  });

  it("B-68 NFR-09 tautan notifikasi hanya asal yang sama (tanpa pengalihan terbuka)", () => {
    expect(safeNotificationPath("/persetujuan?id=1", ORIGIN)).toBe("/persetujuan?id=1");
    expect(safeNotificationPath(`${ORIGIN}/kas`, ORIGIN)).toBe("/kas");
    expect(safeNotificationPath("https://jahat.example/phish", ORIGIN)).toBe("/");
    expect(safeNotificationPath("//jahat.example/x", ORIGIN)).toBe("/");
    expect(safeNotificationPath("javascript:alert(1)", ORIGIN)).toBe("/");
    expect(safeNotificationPath(undefined, ORIGIN)).toBe("/");
  });

  it("B-68 service worker mendaftarkan event push & notificationclick memakai pembangun yang sama", () => {
    const sw = readFileSync("src/app/sw.ts", "utf8");
    expect(sw).toMatch(/addEventListener\("push"/);
    expect(sw).toMatch(/addEventListener\("notificationclick"/);
    expect(sw).toMatch(/buildPushNotification/);
  });
});
