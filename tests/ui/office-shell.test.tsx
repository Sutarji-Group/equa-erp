// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/pesanan/0199aa", useRouter: () => ({ push: vi.fn() }) }));

import { OfficeBreadcrumbLabel, OfficeShell } from "@/components/shared/office-shell";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeAll(() => {
  // next-themes membaca matchMedia.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

describe("OfficeShell", () => {
  afterEach(() => cleanup());

  it("menyaring menu sesuai izin, menandai item aktif, dan menampilkan hitungan", () => {
    render(
      <TooltipProvider>
        <OfficeShell
          user={{ name: "Sari Rahayu", roleLabels: ["Dispatcher"] }}
          permissions={["m2.order.read", "m2.order.create", "m10.approval.read"]}
          counts={{ approvals: 4, notifications: 120 }}
        >
          <OfficeBreadcrumbLabel label="P-26-000123" />
          <p>Isi halaman</p>
        </OfficeShell>
      </TooltipProvider>,
    );
    const nav = screen.getAllByRole("navigation", { name: "Menu utama" })[0]!;
    expect(within(nav).getByRole("link", { name: "Pesanan" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).queryByRole("link", { name: "Kas hari ini" })).toBeNull();
    expect(screen.getByText("Isi halaman")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Persetujuan, 4 menunggu/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Notifikasi, 120 belum dibaca/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Menu pengguna: Sari Rahayu" })).toBeTruthy();
    // Breadcrumb: label rincian ditimpa halaman.
    expect(screen.getByText("P-26-000123")).toBeTruthy();
  });

  it("tanpa izin persetujuan → tautan persetujuan tidak tampil", () => {
    render(
      <TooltipProvider>
        <OfficeShell user={{ name: "Akuntan", roleLabels: ["Akuntan"] }} permissions={["m11.journal.read"]}>
          <p>x</p>
        </OfficeShell>
      </TooltipProvider>,
    );
    expect(screen.queryByRole("link", { name: /^Persetujuan/ })).toBeNull();
  });
});
