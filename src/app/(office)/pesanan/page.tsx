import { FilePlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m2-orders/action-form";
import { FormGrid, SelectField, TextAreaField, TextField } from "@/components/m2-orders/fields";
import { OrderTable } from "@/components/m2-orders/order-table";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatTanggal, monthOf, toBusinessDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";

import { updateTemplateAction } from "./actions";

export const metadata: Metadata = { title: "Pesanan" };

const FLAGS = [
  { value: "duplicate", label: "Kemungkinan dobel" },
  { value: "reschedule", label: "Perlu jadwal ulang" },
  { value: "reconfirm", label: "Perlu konfirmasi ulang" },
  { value: "after_cutoff", label: "H+0 dipaksa" },
  { value: "provisional", label: "Harga sementara" },
];

function one(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Pesanan (US-M2-02 KP-4): cari & saring (nomor, pelanggan, tanggal, status, truk, cara bayar) + ekspor; tampilan
 * laporan bulanan (US-M2-04 KP-3 KPI-06, US-M2-09 KP-4, tinjauan 6.2c) dan template WA konfirmasi (pemilik, US-M2-07).
 */
export default async function PesananPage({ searchParams }: PageProps<"/pesanan">) {
  const { ctx } = await requirePermission("m2.order.read");
  const sp = await searchParams;
  const view = one(sp.tampil) ?? "daftar";
  const canCreate = can(ctx, "m2.order.create");
  const canTemplate = can(ctx, "m1.wa_template.read");
  const tabs = [
    { key: "daftar", label: "Daftar pesanan" },
    { key: "laporan", label: "Laporan bulanan" },
    ...(canTemplate ? [{ key: "template", label: "Template WA" }] : []),
  ];
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pesanan"
        description="Setiap pesanan bernomor, berstatus, dan terjadwal ke truk — tidak terlewat, tidak dobel."
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/pesanan/baru">
                <FilePlus aria-hidden />
                Pesanan baru
              </Link>
            </Button>
          ) : null
        }
      />
      <nav className="flex flex-wrap gap-2" aria-label="Tampilan pesanan">
        {tabs.map((t) => (
          <Button key={t.key} asChild variant={view === t.key ? "default" : "outline"} size="sm">
            <Link href={t.key === "daftar" ? "/pesanan" : `/pesanan?tampil=${t.key}`} aria-current={view === t.key ? "page" : undefined}>
              {t.label}
            </Link>
          </Button>
        ))}
      </nav>
      {view === "laporan" ? <MonthlyView month={one(sp.bulan) ?? monthOf(toBusinessDate(ctx.now))} /> : view === "template" && canTemplate ? <TemplateView /> : <ListView sp={sp} />}
    </div>
  );
}

async function ListView({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const { ctx } = await requirePermission("m2.order.read");
  const filter: m2.ListOrdersFilter = {
    q: one(sp.q),
    status: one(sp.status) as m2.ListOrdersFilter["status"],
    from: one(sp.dari),
    to: one(sp.sampai),
    truckId: one(sp.truk),
    customerId: one(sp.pelanggan),
    paymentMethod: one(sp.bayar) as m2.ListOrdersFilter["paymentMethod"],
    flag: one(sp.penanda) as m2.ListOrdersFilter["flag"],
  };
  let rows: m2.OrderListRow[] = [];
  let error: string | null = null;
  try {
    rows = await m2.listOrders(ctx, filter);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const counters = await m2.orderCounters(ctx);
  const board = await m2.getBoard(ctx, toBusinessDate(ctx.now));
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as [string, string][]);
  const piiExport = can(ctx, "m9.report.export_pii");
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="Pesanan hari ini" value={String(counters.today)} href={`/pesanan?dari=${toBusinessDate(ctx.now)}&sampai=${toBusinessDate(ctx.now)}`} />
        <KpiTile label="Rit belum terjadwal" value={String(counters.unscheduledTrips)} tone={counters.unscheduledTrips ? "warning" : undefined} href="/jadwal" />
        <KpiTile label="Menunggu persetujuan" value={String(counters.awaiting)} href="/pesanan?status=awaiting_approval" />
        <KpiTile label="Kemungkinan dobel" value={String(counters.duplicates)} tone={counters.duplicates ? "warning" : undefined} href="/pesanan?penanda=duplicate" />
        <KpiTile label="Perlu jadwal ulang" value={String(counters.reschedule)} tone={counters.reschedule ? "danger" : undefined} href="/pesanan?penanda=reschedule" />
        <KpiTile label="Perlu konfirmasi ulang" value={String(counters.reconfirm)} tone={counters.reconfirm ? "danger" : undefined} href="/pesanan?penanda=reconfirm" />
      </div>
      <SectionCard
        title="Cari & saring"
        actions={
          can(ctx, "m2.order.export") ? (
            piiExport ? (
              <form method="post" action={`/api/export/m2.orders?${qs.toString()}`} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="format" value="xlsx" />
                <input name="purpose" required minLength={5} placeholder="Tujuan ekspor (wajib, BR-39)" className="h-8 w-52 rounded-md border border-input bg-transparent px-2 text-sm" aria-label="Tujuan ekspor" />
                <Button type="submit" variant="outline" size="sm">
                  Ekspor Excel
                </Button>
              </form>
            ) : (
              <ExportButtons excelHref={`/api/export/m2.orders?format=xlsx&${qs.toString()}`} pdfHref={`/api/export/m2.orders?format=pdf&${qs.toString()}`} />
            )
          ) : null
        }
      >
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Saring pesanan">
          <TextField label="Nomor / pelanggan / alamat" name="q" defaultValue={filter.q ?? ""} placeholder="P-26-000123 atau nama" />
          <SelectField label="Status" name="status" defaultValue={filter.status ?? ""} placeholder="Semua status" options={[{ value: "active", label: "Berjalan (belum selesai)" }, ...enumOptions("order_status")]} />
          <TextField label="Tanggal dari" name="dari" type="date" defaultValue={filter.from ?? ""} />
          <TextField label="sampai" name="sampai" type="date" defaultValue={filter.to ?? ""} />
          <SelectField label="Truk" name="truk" defaultValue={filter.truckId ?? ""} placeholder="Semua truk" options={board.lanes.map((l) => ({ value: l.truck.id, label: `${l.truck.code} — ${l.truck.plateNumber}` }))} />
          <SelectField label="Cara bayar" name="bayar" defaultValue={filter.paymentMethod ?? ""} placeholder="Semua" options={enumOptions("payment_method").filter((o) => ["cash", "transfer", "credit", "internal"].includes(o.value))} />
          <SelectField label="Penanda" name="penanda" defaultValue={filter.flag ?? ""} placeholder="Semua" options={FLAGS} />
          {filter.customerId ? <input type="hidden" name="pelanggan" value={filter.customerId} /> : null}
          <div className="flex items-end gap-2">
            <Button type="submit" variant="outline">
              Terapkan
            </Button>
            <Button asChild variant="ghost">
              <Link href="/pesanan">Atur ulang</Link>
            </Button>
          </div>
        </form>
        {filter.customerId ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Disaring untuk satu pelanggan.{" "}
            {can(ctx, "m2.order.export") ? (
              <a className="text-primary underline" href={`/api/export/m2.customer_history?format=xlsx&customerId=${filter.customerId}`}>
                Ekspor riwayat lengkap pelanggan
              </a>
            ) : null}
          </p>
        ) : null}
      </SectionCard>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <OrderTable
        rows={rows.map((r) => ({
          id: r.id,
          number: r.number,
          status: r.status,
          customerName: r.customerName,
          addressLabel: r.addressLabel,
          requestedDate: r.requestedDate,
          requestedTime: r.requestedTime,
          tankCount: r.tankCount,
          paymentMethod: r.paymentMethod,
          totalAmount: r.totalAmount,
          trucks: r.trucks,
          isInternal: r.isInternal,
          recurring: r.source === "recurring",
          possibleDuplicate: r.possibleDuplicate,
          needsReschedule: r.needsReschedule,
          reconfirmPending: r.reconfirmationRequired && !r.reconfirmed,
          collectUnderpayment: r.collectUnderpayment,
          afterCutoffForced: r.afterCutoffForced,
          priceIsProvisional: r.priceIsProvisional,
          createdByName: r.createdByName,
        }))}
      />
    </>
  );
}

async function MonthlyView({ month }: { month: string }) {
  const { ctx } = await requirePermission("m2.order.read");
  const [cf, kpi, overrides] = await Promise.all([m2.monthlyCancelFailReport(ctx, month), m2.kpi06Report(ctx, month), m2.overridesReport(ctx, month)]);
  const canExport = can(ctx, "m2.order.export");
  const exp = (key: string) => (canExport ? <ExportButtons excelHref={`/api/export/${key}?format=xlsx&month=${month}`} pdfHref={`/api/export/${key}?format=pdf&month=${month}`} /> : null);
  return (
    <>
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Pilih bulan">
        <input type="hidden" name="tampil" value="laporan" />
        <TextField label="Bulan" name="bulan" type="month" defaultValue={month} />
        <Button type="submit" variant="outline">
          Tampilkan
        </Button>
      </form>
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiTile label="Pesanan dibatalkan" value={String(cf.totals.cancelled)} />
        <KpiTile label="Batal karena dobel (KPI-06)" value={String(cf.totals.duplicateCancelled)} />
        <KpiTile label="Lewat tanggal tanpa jadwal ulang" value={String(kpi.overdueUnscheduled)} tone={kpi.overdueUnscheduled ? "warning" : undefined} />
        <KpiTile label="Rit gagal" value={String(cf.totals.failed)} tone={cf.totals.failed ? "danger" : undefined} />
      </div>
      <SectionCard title="Alasan pembatalan & rit gagal per pelanggan dan per truk" description="US-M2-09 KP-4 — dasar evaluasi pelanggan & truk." actions={exp("m2.cancel_fail_monthly")}>
        <ReportTable
          headers={["Per", "Pelanggan/truk", "Jenis", "Alasan", "Jumlah"]}
          rows={cf.rows.map((r) => [r.groupType === "customer" ? "Pelanggan" : "Truk", r.groupName, r.kind === "cancel" ? "Batal" : "Gagal", r.reasonLabel, String(r.count)])}
        />
      </SectionCard>
      <SectionCard title="KPI-06: dobel dibatalkan & lewat tanggal tanpa jadwal ulang" actions={exp("m2.kpi06_monthly")}>
        <ReportTable
          headers={["Jenis", "No. pesanan", "Pelanggan", "Tanggal diminta", "Status"]}
          rows={kpi.rows.map((r) => [r.kind === "duplicate_cancelled" ? "Dibatalkan: dobel" : "Lewat tanggal", r.number, r.customerName, formatTanggal(r.requestedDate, { weekday: false }), label("order_status", r.status)])}
        />
      </SectionCard>
      <SectionCard title="Pengesampingan beralasan (6.2c) — tinjauan pemilik" description="Pesanan H+0 setelah batas jam dan pesanan tambahan walau terdeteksi dobel." actions={exp("m2.overrides_monthly")}>
        <ReportTable
          headers={["Jenis", "No. pesanan", "Pelanggan", "Tanggal", "Alasan", "Pelaku"]}
          rows={overrides.map((r) => [r.kind === "after_cutoff" ? "H+0 setelah batas" : "Tambahan walau dobel", r.number, r.customerName, formatTanggal(r.requestedDate, { weekday: false }), r.reason ?? "—", r.createdByName ?? "—"])}
        />
      </SectionCard>
    </>
  );
}

function ReportTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Tidak ada data pada bulan ini.</p>;
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j} className={cn(j === r.length - 1 && headers[j] === "Jumlah" && "text-right tabular-nums")}>
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

async function TemplateView() {
  const { ctx } = await requirePermission("m1.wa_template.read");
  const tpl = await m2.getOrderConfirmationTemplate(ctx);
  const canEdit = can(ctx, "m1.wa_template.update");
  return (
    <SectionCard
      title="Template WhatsApp konfirmasi pesanan"
      description={`Dikelola pemilik (US-M2-07 KP-1). Versi aktif: ${tpl ? tpl.version : "belum ada"}. Variabel: ${m2.ORDER_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}.`}
    >
      {canEdit ? (
        <ActionForm action={updateTemplateAction} submitLabel="Simpan versi baru" resetOnSuccess={false} aria-label="Ubah template WA">
          <FormGrid>
            <TextAreaField label="Isi template" name="body" defaultValue={tpl?.body ?? ""} rows={10} required className="sm:col-span-2" />
            <TextField label="Alasan perubahan" name="reason" required placeholder="Mis. tambah nomor rekening" />
          </FormGrid>
        </ActionForm>
      ) : (
        <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{tpl?.body ?? "Belum ada template."}</pre>
      )}
    </SectionCard>
  );
}
