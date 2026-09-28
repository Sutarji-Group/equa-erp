"use client";

import { DataTable, dataTableColumns } from "@/components/shared/data-table";
import { MoneyText } from "@/components/shared/money-text";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";

export type CustomerTableRow = {
  id: string;
  code: string | null;
  name: string;
  segment: string;
  waPhone: string | null;
  creditStatus: string;
  creditLimit: number;
  isStorePartner: boolean;
  isActive: boolean;
  isInitialData: boolean;
  addressCount: number;
  unlockedCount: number;
  zones: string;
};

const col = dataTableColumns<CustomerTableRow>();
const columns = col.columns([
  col.accessor("name", {
    header: "Pelanggan",
    cell: (c) => (
      <div className="min-w-0">
        <div className="font-medium">{c.getValue()}</div>
        <div className="text-xs text-muted-foreground">
          {c.row.original.code ?? "—"}
          {c.row.original.isInitialData ? " · data awal" : ""}
        </div>
      </div>
    ),
  }),
  col.accessor("segment", { header: "Segmen", cell: (c) => <StatusBadge enumName="customer_segment" value={c.getValue()} dot={false} />, meta: { hideOnMobile: true } }),
  col.accessor("waPhone", { header: "WA", cell: (c) => c.getValue() ?? "—", meta: { hideOnMobile: true } }),
  col.accessor("creditStatus", { header: "Kredit", cell: (c) => <StatusBadge enumName="credit_status" value={c.getValue()} /> }),
  col.accessor("creditLimit", { header: "Batas", cell: (c) => <MoneyText value={c.getValue()} />, meta: { align: "right", hideOnMobile: true, searchable: false } }),
  col.accessor("zones", {
    header: "Zona / koordinat",
    cell: (c) => (
      <span className="text-sm">
        {c.getValue()}
        {c.row.original.unlockedCount > 0 ? <span className="ml-1 text-xs text-warning-foreground">· {c.row.original.unlockedCount} belum dikunci</span> : null}
      </span>
    ),
    meta: { hideOnMobile: true },
  }),
  col.accessor("isActive", {
    header: "Status",
    cell: (c) => (
      <div className="flex flex-wrap gap-1">
        {c.getValue() ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}
        {c.row.original.isStorePartner ? <ToneBadge tone="info">Mitra toko</ToneBadge> : null}
      </div>
    ),
    meta: { searchable: false },
  }),
]);

/** Daftar pelanggan (US-M1-01) — pencarian nama/kode/WA, urut kolom, baris menuju rincian. */
export function CustomerTable({ rows }: { rows: CustomerTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/master/pelanggan/${r.id}`}
      searchPlaceholder="Cari nama, kode, atau nomor WA…"
      emptyTitle="Belum ada pelanggan"
      emptyDescription="Tambahkan pelanggan baru atau impor data awal."
      caption="Daftar pelanggan"
    />
  );
}
