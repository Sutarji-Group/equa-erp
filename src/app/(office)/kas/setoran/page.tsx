import type { Metadata } from "next";
import Link from "next/link";

import { DateFilterInput, FilterForm, LinkTabs, hrefWith } from "@/components/m4-cash/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import * as m4 from "@/server/modules/m4-cash";

export const metadata: Metadata = { title: "Setoran" };

function DepositTable({ rows, testId }: { rows: m4.DepositListRow[]; testId: string }) {
  if (!rows.length) return <EmptyState title="Tidak ada setoran" compact />;
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>Setoran</TableHead>
            <TableHead>Penyetor</TableHead>
            <TableHead>Tanggal</TableHead>
            <TableHead className="text-right">Seharusnya</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Diterima</TableHead>
            <TableHead className="text-right">Selisih</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} className={r.depotLate ? "bg-warning/10" : undefined}>
              <TableCell>
                <Link href={`/kas/setoran/${r.id}`} className="font-medium text-primary hover:underline">
                  {r.number}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  {label("deposit_source_type", r.sourceType)}
                  {r.isPartial ? " · setor sebagian" : ""}
                  {r.method === "bank_slip" ? " · setor bank (slip)" : ""}
                </span>
              </TableCell>
              <TableCell className="text-sm">
                {r.sourceLabel}
                {r.sourceDetail ? <span className="block text-xs text-muted-foreground">{r.sourceDetail}</span> : null}
              </TableCell>
              <TableCell className="text-sm">
                {formatTanggal(r.businessDate, { weekday: false })}
                {r.submittedAt ? <span className="block text-xs text-muted-foreground">Diajukan {formatTanggalJam(r.submittedAt)}</span> : null}
              </TableCell>
              <TableCell className="text-right font-medium">{formatRupiah(r.expectedNet)}</TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <StatusBadge enumName="deposit_status" value={r.status} />
                  {r.sync && !r.sync.fullySynced ? <ToneBadge tone="warning">Menunggu sinkron</ToneBadge> : null}
                  {r.pendingExpenses ? <ToneBadge tone="info">{r.pendingExpenses} pengeluaran menunggu verifikasi</ToneBadge> : null}
                  {r.awaitingTransferMatch ? <ToneBadge tone="info">Menunggu mutasi bank</ToneBadge> : null}
                  {r.depotLate ? <ToneBadge tone="danger">Terlambat &gt; batas setor</ToneBadge> : null}
                  {r.submittedLate || r.receivedLate ? <ToneBadge tone="warning">Terlambat</ToneBadge> : null}
                </div>
              </TableCell>
              <TableCell className="text-right">{r.receivedAmount === null ? "—" : formatRupiah(r.receivedAmount)}</TableCell>
              <TableCell className={`text-right ${r.discrepancyAmount ? "text-destructive" : ""}`}>
                {r.discrepancyAmount === null ? "—" : formatRupiah(r.discrepancyAmount, { signed: true })}
                {r.discrepancyReason ? <span className="block text-xs text-muted-foreground">{label("discrepancy_reason", r.discrepancyReason)}</span> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Setoran (US-M4-02 KP-1): setoran Diajukan sopir & tutup shift depot/toko belum disetor/diterima, setoran lewat slip
 * menunggu mutasi, setoran Diterima yang belum Ditutup, dan riwayat per tanggal.
 */
export default async function DepositsPage({ searchParams }: { searchParams: Promise<{ tampil?: string; dari?: string; sampai?: string }> }) {
  const { ctx } = await requirePermission("m4.deposit.read");
  const sp = await searchParams;
  const view = sp.tampil === "riwayat" ? "riwayat" : "terima";
  const today = ctxBusinessDate(ctx);
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : addDays(to, -6);
  return (
    <div className="grid grid-cols-1 gap-6">
      <PageHeader
        title="Setoran"
        description="Terima setoran sopir, depot, dan toko. Angka seharusnya dihitung sistem; masukkan jumlah fisik lalu verifikasi pengeluaran rit."
        actions={<ExportButtons excelHref={hrefWith("/api/export/m4.deposits", { format: "xlsx", from, to })} pdfHref={hrefWith("/api/export/m4.deposits", { format: "pdf", from, to })} />}
      />
      <LinkTabs
        label="Tampilan setoran"
        active={view}
        tabs={[
          { key: "terima", label: "Menunggu diterima", href: "/kas/setoran" },
          { key: "riwayat", label: "Riwayat", href: "/kas/setoran?tampil=riwayat" },
        ]}
      />
      {view === "terima" ? <WaitingView ctx={ctx} /> : <HistoryView ctx={ctx} from={from} to={to} />}
    </div>
  );
}

async function WaitingView({ ctx }: { ctx: Parameters<typeof m4.listDepositsForReceipt>[0] }) {
  const { waiting, received } = await m4.listDepositsForReceipt(ctx);
  return (
    <>
      <SectionCard title={`Menunggu diterima (${waiting.length})`} description="Setoran sopir Diajukan, tutup shift depot/toko, dan setor bank dengan slip." flush>
        <DepositTable rows={waiting} testId="setoran-menunggu" />
      </SectionCard>
      <SectionCard title={`Diterima, belum ditutup (${received.length})`} flush>
        <DepositTable rows={received} testId="setoran-diterima" />
      </SectionCard>
    </>
  );
}

async function HistoryView({ ctx, from, to }: { ctx: Parameters<typeof m4.listDeposits>[0]; from: string; to: string }) {
  const rows = await m4.listDeposits(ctx, { from, to });
  return (
    <>
      <FilterForm action="/kas/setoran">
        <input type="hidden" name="tampil" value="riwayat" />
        <DateFilterInput name="dari" value={from} label="Dari" />
        <DateFilterInput name="sampai" value={to} label="Sampai" />
      </FilterForm>
      <SectionCard title={`Riwayat setoran ${formatTanggal(from, { weekday: false })} – ${formatTanggal(to, { weekday: false })}`} flush>
        <DepositTable rows={rows} testId="setoran-riwayat" />
      </SectionCard>
    </>
  );
}
