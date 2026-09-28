import { describe, expect, it } from "vitest";

import { allNavItems } from "@/components/shared/nav/registry";
import { isFieldPath, OFFICE_ROUTES_UNDER_FIELD_PREFIX } from "@/lib/field-routes";
import { config } from "@/proxy";

/** Awalan dari matcher proxy (`/x/:path*` → `/x`). */
const PROXY_PREFIXES = config.matcher.map((m) => m.replace(/\/:path\*$/, ""));

function guardedByProxy(href: string): boolean {
  const path = href.split("?")[0]!;
  return PROXY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

describe("Ruang nama rute lapangan vs kantor (docs/ARCHITECTURE.md §1/§9)", () => {
  it("Bab 6.5 rute lapangan dikenali; subrute kantor M8 di bawah /produksi bukan rute lapangan", () => {
    expect(isFieldPath("/sopir")).toBe(true);
    expect(isFieldPath("/pos/shift")).toBe(true);
    expect(isFieldPath("/produksi")).toBe(true);
    expect(isFieldPath("/produksi/meter")).toBe(true);
    expect(isFieldPath("/produksi/neraca-air")).toBe(false);
    expect(isFieldPath("/produksi/mutu/123")).toBe(false);
    expect(isFieldPath("/produksi-kantor")).toBe(false);
    expect(isFieldPath("/beranda")).toBe(false);
  });

  it("NFR-09 semua href nav kantor BUKAN rute lapangan (tidak di-cache SW) dan dijaga proxy (cookie)", () => {
    const hrefs = allNavItems().map((i) => i.href);
    const cachedOnDevice = hrefs.filter((h) => isFieldPath(h.split("?")[0]!));
    expect(cachedOnDevice, "href kantor tergolong rute lapangan — daftarkan di OFFICE_ROUTES_UNDER_FIELD_PREFIX").toEqual([]);
    const unguarded = hrefs.filter((h) => !guardedByProxy(h));
    expect(unguarded, "href kantor tidak ada di matcher src/proxy.ts").toEqual([]);
  });

  it("subrute kantor M8 terdaftar juga di matcher proxy", () => {
    for (const route of OFFICE_ROUTES_UNDER_FIELD_PREFIX) expect(guardedByProxy(route), route).toBe(true);
  });
});
