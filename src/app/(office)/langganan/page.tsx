import { Play } from "lucide-react";
import type { Metadata } from "next";

import { ActionButton, ReasonActionButton } from "@/components/m2-orders/action-buttons";
import { RecurringForm } from "@/components/m2-orders/recurring-form";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";

import { recurringStatusAction, resolveFailureAction, runGenerationAction } from "./actions";

export const metadata: Metadata = { title: "Pesanan berulang" };

const DAY = ["", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

/**
 * Pesanan berulang / langganan (US-M2-06): pola hari/interval, status Aktif/Jeda/Berakhir, pesanan dibuat otomatis
 * H-PAR-34 bertanda "langganan" (kontrol kredit berlaku), daftar pesanan langganan yang gagal dibuat.
 */
export default async function LanggananPage() {
  const { ctx } = await requirePermission("m2.recurring_order.read");
  const today = toBusinessDate(ctx.now);
  const [rows, failures] = await Promise.all([m2.listRecurringOrders(ctx), m2.listRecurringFailures(ctx)]);
  const daysBefore = await m2.recurringDaysBefore(ctx);
  const canCreate = can(ctx, "m2.recurring_order.create");
  const canUpdate = can(ctx, "m2.recurring_order.update");
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pesanan berulang"
        description={`Pola langganan menghasilkan pesanan Baru bertanda "langganan" otomatis ${daysBefore} hari sebelum tanggal kirim (PAR-34).`}
        actions={
          <>
            <ExportButtons excelHref="/api/export/m2.recurring_orders?format=xlsx" pdfHref="/api/export/m2.recurring_orders?format=pdf" />
            {canUpdate ? <ActionButton label="Buat pesanan langganan sekarang" variant="outline" icon={<Play aria-hidden />} action={runGenerationAction} /> : null}
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Pola aktif" value={String(rows.filter((r) => r.status === "active").length)} />
        <KpiTile label="Pola dijeda" value={String(rows.filter((r) => r.status === "paused").length)} />
        <KpiTile label="Gagal dibuat (belum ditindaklanjuti)" value={String(failures.length)} tone={failures.length ? "danger" : "success"} href="#gagal" />
      </div>

      <section id="gagal">
        <SectionCard
          title="Pesanan langganan yang gagal dibuat"
          description="Mis. kredit Ditahan, melampaui batas, kurang bayar kedua, pelanggan nonaktif (US-M2-06 KP-4)."
          actions={<ExportButtons excelHref="/api/export/m2.recurring_failures?format=xlsx" />}
        >
          {failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada kegagalan yang menunggu tindak lanjut.</p>
          ) : (
            <ul className="grid gap-2">
              {failures.map((f) => (
                <li key={f.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {f.customerName} · {formatTanggal(f.targetDate)}
                    </p>
                    <p>
                      <ToneBadge tone="danger">{label("recurring_failure_reason", f.reason)}</ToneBadge> <span className="text-muted-foreground">{f.message}</span>
                    </p>
                  </div>
                  {canUpdate ? <ReasonActionButton label="Tandai ditindaklanjuti" title="Tindak lanjut pesanan langganan gagal" description="Mis. pelanggan dihubungi, pesanan dibuat manual dengan persetujuan." action={resolveFailureAction.bind(null, f.id)} /> : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </section>

      <SectionCard title="Pola langganan">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada pola langganan" description="Buat pola untuk pelanggan rutin (mis. hotel setiap Senin & Kamis)." compact />
        ) : (
          <ul className="grid gap-3">
            {rows.map((r) => (
              <li key={r.id} className="grid gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{r.customerName}</p>
                    <p className="text-sm text-muted-foreground">
                      {r.addressLabel} — {r.addressText}
                    </p>
                    <p className="text-sm">
                      {r.pattern === "weekly" ? `Setiap ${(r.daysOfWeek ?? []).map((d) => DAY[d]).join(", ")}` : `Setiap ${r.intervalDays} hari`} · {r.tankCount} tangki
                      {r.requestedTime ? ` · pukul ${r.requestedTime.slice(0, 5).replace(":", ".")}` : ""} · {label("payment_method", r.paymentMethod)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Mulai {formatTanggal(r.startDate, { weekday: false })}
                      {r.endDate ? ` s.d. ${formatTanggal(r.endDate, { weekday: false })}` : ""} · {r.generatedCount} pesanan dibuat
                      {r.lastGeneratedDate ? ` · dibangkitkan s.d. ${formatTanggal(r.lastGeneratedDate, { weekday: false })}` : ""} · dibuat {formatTanggalJam(r.createdAt)} {r.createdByName ? `oleh ${r.createdByName}` : ""}
                    </p>
                    {r.nextDates.length ? <p className="text-xs">Kirim berikutnya: {r.nextDates.map((d) => formatTanggal(d, { weekday: true })).join("; ")}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge enumName="recurring_status" value={r.status} tone={r.status === "active" ? "success" : r.status === "paused" ? "warning" : "muted"} />
                    {canUpdate && r.status === "active" ? <ReasonActionButton label="Jeda" title="Jeda pola langganan?" description="Pola yang dijeda tidak menghasilkan pesanan." action={recurringStatusAction.bind(null, r.id, "paused")} /> : null}
                    {canUpdate && r.status === "paused" ? <ReasonActionButton label="Aktifkan" title="Aktifkan kembali?" action={recurringStatusAction.bind(null, r.id, "active")} /> : null}
                    {canUpdate && r.status !== "ended" ? <ReasonActionButton label="Akhiri" title="Akhiri pola langganan?" description="Pola yang berakhir tidak dapat diaktifkan kembali." destructive action={recurringStatusAction.bind(null, r.id, "ended")} /> : null}
                  </div>
                </div>
                {canUpdate && r.status !== "ended" ? (
                  <details>
                    <summary className="cursor-pointer text-sm text-primary">Ubah pola (pesanan yang sudah dibuat tidak berubah)</summary>
                    <div className="mt-3">
                      <RecurringForm
                        today={today}
                        initial={{
                          id: r.id,
                          customer: {
                            value: r.customerId,
                            label: r.customerName,
                            code: r.customerCode,
                            creditStatus: r.customerCreditStatus,
                            isActive: true,
                            notes: null,
                            fixedReceiveTime: null,
                            lastAddressId: r.addressId,
                            addresses: r.customerAddresses.map((a) => ({ ...a, zoneCode: null })),
                          },
                          addressId: r.addressId,
                          pattern: r.pattern,
                          daysOfWeek: r.daysOfWeek ?? [],
                          intervalDays: r.intervalDays,
                          tankCount: r.tankCount,
                          requestedTime: r.requestedTime,
                          paymentMethod: r.paymentMethod as "cash",
                          startDate: r.startDate,
                          endDate: r.endDate,
                          notes: r.notes,
                        }}
                      />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {canCreate ? (
        <SectionCard title="Pola langganan baru" description="Pelanggan, alamat, hari dalam minggu atau interval hari, jumlah tangki, jam, cara bayar, tanggal mulai/berakhir (US-M2-06 KP-1).">
          <RecurringForm today={today} />
        </SectionCard>
      ) : null}
    </div>
  );
}
