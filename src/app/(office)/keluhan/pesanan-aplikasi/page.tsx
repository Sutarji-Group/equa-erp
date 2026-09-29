import type { Metadata } from "next";
import Link from "next/link";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { P2OfficeTabs } from "@/components/p2-customer/office-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p2 from "@/server/modules/p2-customer";

import { p2Tabs } from "../_tabs";
import { confirmAppOrderAction, rejectAppOrderAction } from "../actions";

export const metadata: Metadata = { title: "Pesanan aplikasi" };

/**
 * Pesanan dari aplikasi pelanggan (US-P2-02 KP-4): masuk M2 berstatus Baru bertanda "dari aplikasi"; Dispatcher
 * mengonfirmasi atau menolak beralasan ≤ PAR-75 (2 jam layanan) — lewat tenggat ditandai & diberitahukan. Menjadwalkan
 * di papan (Terjadwal) juga dihitung sebagai konfirmasi.
 */
export default async function PesananAplikasiPage({ searchParams }: PageProps<"/keluhan/pesanan-aplikasi">) {
  const { ctx } = await requirePermission("p2.app_order.read");
  const sp = await searchParams;
  const view = sp.tampil === "semua" ? "all" : "pending";
  const rows = await p2.listAppOrders(ctx, { view });
  const canConfirm = can(ctx, "p2.app_order.confirm");
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pesanan aplikasi"
        description="Konfirmasi (jadwalkan) atau tolak beralasan paling lambat 2 jam layanan (PAR-75). Aturan Tahap 1 tetap berlaku: harga master, kontrol kredit, cek dobel."
        actions={<ExportButtons excelHref={`/api/export/p2.app_orders?format=xlsx&view=${view}`} pdfHref={`/api/export/p2.app_orders?format=pdf&view=${view}`} />}
      />
      <P2OfficeTabs tabs={p2Tabs(ctx)} current="/keluhan/pesanan-aplikasi" />
      <div className="flex gap-2">
        <Button asChild size="sm" variant={view === "pending" ? "secondary" : "ghost"}>
          <Link href="/keluhan/pesanan-aplikasi">Menunggu konfirmasi</Link>
        </Button>
        <Button asChild size="sm" variant={view === "all" ? "secondary" : "ghost"}>
          <Link href="/keluhan/pesanan-aplikasi?tampil=semua">Semua</Link>
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Tidak ada pesanan aplikasi" description="Pesanan baru dari aplikasi pelanggan akan muncul di sini." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2" data-testid="app-orders">
          {rows.map((r) => (
            <SectionCard
              key={r.orderId}
              title={
                <Link href={`/pesanan/${r.orderId}`} className="text-primary hover:underline">
                  {r.number} — {r.customerName}
                </Link>
              }
              actions={<StatusBadge enumName="order_status" value={r.status} />}
            >
              <p className="text-sm">
                {formatTanggal(r.requestedDate)}
                {r.slot ? ` · ${label("delivery_slot", r.slot)}` : ""} · {r.tankCount} tangki · {formatRupiah(r.total)}
              </p>
              <p className="text-sm text-muted-foreground">
                {label("customer_payment_choice", r.paymentPreference)}
                {r.prepaid ? " · sudah dibayar di muka" : ""} · diajukan {formatTanggalJam(r.createdAt)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {r.possibleDuplicate ? <ToneBadge tone="warning">Kemungkinan dobel</ToneBadge> : null}
                {r.overdue ? <ToneBadge tone="danger">Lewat tenggat konfirmasi</ToneBadge> : r.confirmDueAt && !r.confirmedAt && !r.rejectedAt ? <ToneBadge tone="info">Tenggat {formatTanggalJam(r.confirmDueAt)}</ToneBadge> : null}
                {r.confirmedAt ? <ToneBadge tone="success">Dikonfirmasi {formatTanggalJam(r.confirmedAt)}</ToneBadge> : null}
                {r.rejectedAt ? <ToneBadge tone="danger">Ditolak: {r.rejectReason}</ToneBadge> : null}
                {r.cancelledByCustomer ? <ToneBadge tone="muted">Dibatalkan pelanggan</ToneBadge> : null}
              </div>
              {canConfirm && !r.confirmedAt && !r.rejectedAt && r.status !== "cancelled" ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <P2ActionForm action={confirmAppOrderAction.bind(null, r.orderId)} submitLabel="Konfirmasi" size="sm" testId={`confirm-${r.number}`}>
                    <input name="note" placeholder="Catatan (opsional)" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
                  </P2ActionForm>
                  <P2ActionForm action={rejectAppOrderAction.bind(null, r.orderId)} submitLabel="Tolak" size="sm" variant="destructive">
                    <input name="reason" required minLength={5} placeholder="Alasan (tampil ke pelanggan)" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
                  </P2ActionForm>
                </div>
              ) : null}
            </SectionCard>
          ))}
        </div>
      )}
    </div>
  );
}
