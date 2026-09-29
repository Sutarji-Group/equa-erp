import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, MonthFilter } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { publishReportsAction, runBillingAction } from "../actions";

export const metadata: Metadata = { title: "Tagihan langganan" };

/**
 * Tagihan langganan sistem mitra (US-P3-09): pratinjau bulan layanan (outlet aktif × tarif kontrak PAR-35, royalti
 * Tahap 3, air tempo gabungan BR-05), faktur mitra & statusnya di M5 (pelunasan, umur, penahanan). Terbit otomatis
 * tanggal PAR-12; Admin Keuangan dapat menerbitkan sekarang bila job belum berjalan.
 */
export default async function SubscriptionPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission("p3.subscription.read");
  const board = await p3.subscriptionBoard(ctx, { month: sp.bulan ?? null });

  return (
    <div className="grid gap-6">
      <PageHeader title="Tagihan langganan mitra" description={`Bulan layanan ${board.month}: terbit ${formatTanggal(board.issueDate)}, jatuh tempo ${formatTanggal(board.dueDate)} (PAR-12). Koreksi hanya lewat nota kredit di Piutang (BR-38).`} actions={<ExportButtons excelHref="/api/export/p3.subscription_invoices?format=xlsx" pdfHref="/api/export/p3.subscription_invoices?format=pdf" />} />
      <MonthFilter month={board.month} label="Bulan layanan" />
      <SectionCard title="Pratinjau tagihan per kontrak">
        {board.rows.length === 0 ? (
          <EmptyState title="Tidak ada kontrak berlaku di bulan ini" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-pratinjau-langganan">
              <TableHeader>
                <TableRow>
                  <TableHead>Kontrak</TableHead>
                  <TableHead>Mitra</TableHead>
                  <TableHead className="text-right">Outlet aktif</TableHead>
                  <TableHead className="text-right">Langganan</TableHead>
                  <TableHead className="text-right">Royalti</TableHead>
                  <TableHead className="text-right">Fee awal</TableHead>
                  <TableHead className="text-right">Air tempo</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Faktur</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.rows.map((r) => (
                  <TableRow key={r.contract.id}>
                    <TableCell>{r.contract.number}</TableCell>
                    <TableCell>{r.tenantName}</TableCell>
                    <TableCell className="text-right" title={r.bill.outlets.map((o) => `${o.code}: ${o.note ?? "ditagih"}`).join("\n")}>
                      {r.bill.outletCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.bill.subscriptionAmount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.bill.royalty.amount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.bill.initialFee} />
                    </TableCell>
                    <TableCell className="text-right">{r.bill.water.applies ? <MoneyText value={r.bill.water.amount} /> : "—"}</TableCell>
                    <TableCell className="text-right font-medium">
                      <MoneyText value={r.bill.total} />
                    </TableCell>
                    <TableCell>{r.bill.existing ? <ToneBadge tone="success">{r.bill.existing.number}</ToneBadge> : <ToneBadge tone="muted">Belum terbit</ToneBadge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Faktur mitra (status M5)">
        {board.invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada faktur mitra.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-faktur-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Faktur</TableHead>
                  <TableHead>Mitra</TableHead>
                  <TableHead>Terbit</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.invoices.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={`/piutang/faktur/${i.id}`} className="text-primary hover:underline">
                        {i.number}
                      </Link>
                    </TableCell>
                    <TableCell>{i.tenantName}</TableCell>
                    <TableCell>{formatTanggal(i.issueDate)}</TableCell>
                    <TableCell>{formatTanggal(i.dueDate)}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={i.amount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={i.outstandingAmount} />
                    </TableCell>
                    <TableCell className="space-x-1">
                      <StatusBadge enumName="invoice_status" value={i.status} />
                      {i.overdueDays > 0 ? <ToneBadge tone="danger">lewat {i.overdueDays} hari</ToneBadge> : null}
                      {i.disputeStatus !== "none" ? <StatusBadge enumName="dispute_status" value={i.disputeStatus} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      {can(ctx, "p3.subscription.issue") || can(ctx, "p3.partner_report.publish") ? (
        <div className="grid gap-4 md:grid-cols-2">
          {can(ctx, "p3.subscription.issue") ? (
            <SectionCard title="Terbitkan tagihan sekarang" description="Hanya bila job tanggal 1 belum berjalan; tetap satu faktur per kontrak per bulan.">
              <P3ActionForm action={runBillingAction} submitLabel="Terbitkan tagihan bulan lalu" testId="form-terbit-langganan" />
            </SectionCard>
          ) : null}
          {can(ctx, "p3.partner_report.publish") ? (
            <SectionCard title="Terbitkan laporan bulanan mitra" description="Otomatis tanggal 5; sekali per mitra per bulan (snapshot).">
              <P3ActionForm action={publishReportsAction} submitLabel="Terbitkan laporan" testId="form-terbit-laporan">
                <Field label="Bulan (YYYY-MM)" name="month" type="month" />
              </P3ActionForm>
            </SectionCard>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
