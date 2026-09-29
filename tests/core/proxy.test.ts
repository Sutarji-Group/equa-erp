import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, proxy } from "@/proxy";

function req(path: string, cookie?: string): NextRequest {
  const r = new NextRequest(new URL(path, "https://equa.test"));
  if (cookie) r.cookies.set("equa_session", cookie);
  return r;
}

describe("B-70 proxy portal mitra (D-11 butir 2)", () => {
  it("B-70 US-P3-10 KP-1 matcher memuat /mitra/:path* di samping rute kantor", () => {
    expect(config.matcher).toContain("/mitra/:path*");
    expect(config.matcher).toContain("/keluhan/:path*");
  });

  it("B-70 tanpa cookie: portal → /mitra/masuk (bukan login kantor); kantor → /masuk?lanjut=", () => {
    const portal = proxy(req("/mitra/tagihan?bulan=2026-09"));
    expect(portal.status).toBe(307);
    expect(new URL(portal.headers.get("location")!).pathname).toBe("/mitra/masuk");
    expect(new URL(portal.headers.get("location")!).search).toBe("");
    const root = proxy(req("/mitra"));
    expect(new URL(root.headers.get("location")!).pathname).toBe("/mitra/masuk");
    const office = proxy(req("/kas/setoran"));
    const loc = new URL(office.headers.get("location")!);
    expect(loc.pathname).toBe("/masuk");
    expect(loc.searchParams.get("lanjut")).toBe("/kas/setoran");
  });

  it("B-70 halaman publik portal (masuk, daftar, keluar) dilewatkan tanpa cookie; cookie ada → lanjut ke layout server", () => {
    for (const p of ["/mitra/masuk", "/mitra/masuk?alasan=akun-nonaktif", "/mitra/daftar", "/mitra/keluar"]) {
      expect(proxy(req(p)).headers.get("location"), p).toBeNull();
    }
    expect(proxy(req("/mitra/penjualan", "token")).headers.get("location")).toBeNull();
    expect(proxy(req("/kas", "token")).headers.get("location")).toBeNull();
  });
});
