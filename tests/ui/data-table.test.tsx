// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/pesanan" }));

import { DataTable, dataTableColumns } from "@/components/shared/data-table";
import { MoneyText } from "@/components/shared/money-text";

type Row = { id: string; number: string; customer: string; total: number };
const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
  id: `r${i + 1}`,
  number: `P-26-${String(i + 1).padStart(6, "0")}`,
  customer: i % 3 === 0 ? "Hotel Puncak" : i % 3 === 1 ? "Pesantren Al-Ikhlas" : "Rumah Makan Sari",
  total: 100_000 + i * 1_000,
}));
const col = dataTableColumns<Row>();
const columns = col.columns([
  col.accessor("number", { header: "Nomor" }),
  col.accessor("customer", { header: "Pelanggan" }),
  col.accessor("total", { header: "Total", cell: (c) => <MoneyText value={c.getValue()} />, meta: { align: "right" } }),
]);

function bodyRows() {
  const [, body] = screen.getAllByRole("rowgroup");
  return within(body!).getAllByRole("row");
}

describe("DataTable (TanStack v9)", () => {
  afterEach(() => {
    cleanup();
    push.mockReset();
  });

  it("paginasi 10 per halaman dan ringkasan jumlah baris", () => {
    render(<DataTable columns={columns} data={rows} pageSize={10} getRowId={(r) => r.id} />);
    expect(bodyRows()).toHaveLength(10);
    expect(screen.getByText("Menampilkan 1–10 dari 30 baris")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(screen.getByText("Menampilkan 11–20 dari 30 baris")).toBeTruthy();
    expect(within(bodyRows()[0]!).getByText("P-26-000011")).toBeTruthy();
  });

  it("filter teks global & keadaan tidak cocok", async () => {
    render(<DataTable columns={columns} data={rows} pageSize={50} />);
    await userEvent.type(screen.getByLabelText("Cari di tabel"), "pesantren");
    expect(bodyRows()).toHaveLength(10);
    expect(screen.getByText(/disaring dari 30/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("Cari di tabel"));
    await userEvent.type(screen.getByLabelText("Cari di tabel"), "zzz");
    expect(screen.getByText("Tidak ada yang cocok")).toBeTruthy();
  });

  it("urut per kolom (klik header) dengan aria-sort", () => {
    render(<DataTable columns={columns} data={rows} pageSize={50} />);
    fireEvent.click(screen.getByRole("button", { name: /Total/ }));
    const header = screen.getByRole("columnheader", { name: /Total/ });
    const first = header.getAttribute("aria-sort");
    expect(first === "ascending" || first === "descending").toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Total/ }));
    const second = header.getAttribute("aria-sort");
    expect(second).not.toBe(first);
    const expectedFirst = second === "descending" ? "Rp 129.000" : "Rp 100.000";
    expect(within(bodyRows()[0]!).getByText(expectedFirst)).toBeTruthy();
  });

  it("baris dapat diklik (onRowClick) & rowHref (router.push, termasuk Enter)", () => {
    const onRowClick = vi.fn();
    const { unmount } = render(<DataTable columns={columns} data={rows.slice(0, 3)} onRowClick={onRowClick} />);
    fireEvent.click(bodyRows()[1]!);
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
    unmount();

    render(<DataTable columns={columns} data={rows.slice(0, 3)} rowHref={(r) => `/pesanan/${r.id}`} />);
    fireEvent.keyDown(bodyRows()[2]!, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/pesanan/r3");
  });

  it("data kosong → EmptyState; slot ekspor tampil", () => {
    render(<DataTable columns={columns} data={[]} emptyTitle="Belum ada pesanan" exportSlot={<a href="#x">Excel</a>} />);
    expect(screen.getByText("Belum ada pesanan")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Excel" })).toBeTruthy();
  });
});
