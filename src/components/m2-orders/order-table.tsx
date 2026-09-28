"use client";

import { DataTable, dataTableColumns } from "@/components/shared/data-table";
import { MoneyText } from "@/components/shared/money-text";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { formatTanggal } from "@/lib/time";

export type OrderTableRow = {
  id: string;
  number: string;
  status: string;
  customerName: string;
  addressLabel: string;
  requestedDate: string;
  requestedTime: string | null;
  tankCount: number;
  paymentMethod: string;
  totalAmount: number;
  trucks: string[];
  isInternal: boolean;
  recurring: boolean;
  possibleDuplicate: boolean;
  needsReschedule: boolean;
  reconfirmPending: boolean;
  collectUnderpayment: boolean;
  afterCutoffForced: boolean;
  priceIsProvisional: boolean;
  createdByName: string | null;
};

export function OrderFlags({ row }: { row: Pick<OrderTableRow, "isInternal" | "recurring" | "possibleDuplicate" | "needsReschedule" | "reconfirmPending" | "collectUnderpayment" | "afterCutoffForced" | "priceIsProvisional"> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.isInternal ? <ToneBadge tone="info">Internal</ToneBadge> : null}
      {row.recurring ? <ToneBadge tone="info">Langganan</ToneBadge> : null}
      {row.possibleDuplicate ? <ToneBadge tone="warning">Kemungkinan dobel</ToneBadge> : null}
      {row.needsReschedule ? <ToneBadge tone="danger">Perlu jadwal ulang</ToneBadge> : null}
      {row.reconfirmPending ? <ToneBadge tone="danger">Konfirmasi ulang</ToneBadge> : null}
      {row.collectUnderpayment ? <ToneBadge tone="warning">Tagih kurang bayar</ToneBadge> : null}
      {row.afterCutoffForced ? <ToneBadge tone="muted">H+0 dipaksa</ToneBadge> : null}
      {row.priceIsProvisional ? <ToneBadge tone="warning">Harga sementara</ToneBadge> : null}
    </div>
  );
}

const col = dataTableColumns<OrderTableRow>();
const columns = col.columns([
  col.accessor("number", {
    header: "No. pesanan",
    cell: (c) => (
      <div className="min-w-0">
        <div className="font-medium tabular-nums">{c.getValue()}</div>
        <div className="text-xs text-muted-foreground">{c.row.original.createdByName ?? "Sistem"}</div>
      </div>
    ),
  }),
  col.accessor("customerName", {
    header: "Pelanggan",
    cell: (c) => (
      <div className="min-w-0">
        <div className="font-medium">{c.getValue()}</div>
        <div className="text-xs text-muted-foreground">{c.row.original.addressLabel}</div>
        <OrderFlags row={c.row.original} />
      </div>
    ),
  }),
  col.accessor("requestedDate", {
    header: "Tanggal",
    cell: (c) => (
      <span className="whitespace-nowrap">
        {formatTanggal(c.getValue(), { weekday: false })}
        {c.row.original.requestedTime ? ` ${c.row.original.requestedTime.replace(":", ".")}` : ""}
      </span>
    ),
    meta: { searchable: false },
  }),
  col.accessor("tankCount", { header: "Tangki", meta: { align: "right", searchable: false } }),
  col.accessor("paymentMethod", { header: "Bayar", cell: (c) => <StatusBadge enumName="payment_method" value={c.getValue()} dot={false} />, meta: { hideOnMobile: true, searchable: false } }),
  col.accessor("totalAmount", { header: "Total", cell: (c) => <MoneyText value={c.getValue()} />, meta: { align: "right", hideOnMobile: true, searchable: false } }),
  col.accessor("trucks", { header: "Truk", cell: (c) => c.getValue().join(", ") || "—", meta: { hideOnMobile: true, searchable: false } }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge enumName="order_status" value={c.getValue()} />, meta: { searchable: false } }),
]);

/** Daftar pesanan (US-M2-02 KP-4) — klik baris membuka rincian. */
export function OrderTable({ rows }: { rows: OrderTableRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/pesanan/${r.id}`}
      searchPlaceholder="Cari nomor atau pelanggan di daftar ini…"
      emptyTitle="Tidak ada pesanan"
      emptyDescription="Ubah saringan atau buat pesanan baru."
    />
  );
}
