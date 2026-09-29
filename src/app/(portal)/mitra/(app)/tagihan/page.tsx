import type { Metadata } from "next";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { MonthFilter, TextAreaField } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal, toBusinessDate } from "@/lib/time";
import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";
import { disputeInvoiceAction } from "../../actions";

export const metadata: Metadata = { title: "Tagihan & pembayaran" };

const num = (n: number) => n.toLocaleString("id-ID");

/**
 * Tagihan & pembayaran mitra (RL-7 US-P3-09 KP-2, US-P3-10 KP-2): faktur M5 pelanggan mitra (langganan sistem, air &
 * spare part tempo yang digabung), rincian komponen, pembayaran. Tahap 3: rincian dasar royalti per outlet per hari
 * dan sengketa ≤ 7 hari (US-P3-04 KP-2). Pembayaran: transfer atau tunai ke Admin Keuangan EQUA (US-P3-04 KP-3).
 */
export default async function PortalInvoicesPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx, tenant } = await requirePortalSession();
  const rows = await p3.portalInvoices(ctx);
  const phase3 = await p3.portalEnabled(getDb(), tenant.id);
  const royalty = phase3 ? await p3.portalRoyaltyDetail(ctx, { month: sp.bulan ?? null }) : [];
  const outstanding = rows.reduce((s, r) => s + r.outstandingAmount, 0);
  const overdue = rows.filter((r) => r.overdueDays > 0).reduce((s, r) => s + r.outstandingAmount, 0);
  const paid = rows.reduce((s, r) => s + r.paidAmount, 0);

  return (
    <>
      <PageHeader title="Tagihan & pembayaran" description="Faktur dari EQUA untuk outlet Anda. Bayar lewat transfer ke rekening EQUA atau tunai ke Admin Keuangan; pelunasan tercatat di sini." />
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Sisa tagihan" value={<MoneyText value={outstanding} />} />
        <KpiTile label="Lewat jatuh tempo" value={<MoneyText value={overdue} />} tone={overdue ? "danger" : "neutral"} hint={overdue ? "Tunggakan lama dapat berujung teguran & mode baca-saja." : undefined} />
        <KpiTile label="Sudah dibayar" value={<MoneyText value={paid} />} />
      </div>

      <SectionCard title="Faktur">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada tagihan" description="Tagihan langganan sistem terbit tanggal 1 untuk bulan sebelumnya." compact />
        ) : (
          <ul className="grid gap-3" data-testid="daftar-tagihan-mitra">
            {rows.map((inv) => (
              <li key={inv.id} className="rounded-md border bg-background p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{inv.number}</span>
                  {inv.periodMonth ? <span className="text-muted-foreground">bulan layanan {inv.periodMonth.slice(0, 7)}</span> : null}
                  <StatusBadge enumName="invoice_status" value={inv.status} />
                  {inv.overdueDays > 0 ? <ToneBadge tone="danger">lewat {inv.overdueDays} hari</ToneBadge> : null}
                  {inv.disputeStatus !== "none" ? <ToneBadge tone="warning">{label("dispute_status", inv.disputeStatus)}</ToneBadge> : null}
                  <span className="ml-auto font-semibold">
                    <MoneyText value={inv.amount} />
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Terbit {formatTanggal(inv.issueDate)} · jatuh tempo {formatTanggal(inv.dueDate)} · dibayar <MoneyText value={inv.paidAmount} /> · sisa <MoneyText value={inv.outstandingAmount} />
                  {inv.creditedAmount ? (
                    <>
                      {" "}
                      · nota kredit <MoneyText value={inv.creditedAmount} />
                    </>
                  ) : null}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm font-medium text-primary">Rincian & pembayaran</summary>
                  <div className="mt-2 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Komponen</TableHead>
                          <TableHead>Uraian</TableHead>
                          <TableHead className="text-right">Jumlah</TableHead>
                          <TableHead className="text-right">Harga</TableHead>
                          <TableHead className="text-right">Nilai</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {inv.lines.map((l, i) => (
                          <TableRow key={i}>
                            <TableCell>{label("invoice_line_component", l.component)}</TableCell>
                            <TableCell>{l.description}</TableCell>
                            <TableCell className="text-right">{num(l.quantity)}</TableCell>
                            <TableCell className="text-right">
                              <MoneyText value={l.unitPrice} />
                            </TableCell>
                            <TableCell className="text-right">
                              <MoneyText value={l.amount} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {inv.payments.length ? (
                    <ul className="mt-2 grid gap-1 text-xs">
                      {inv.payments.map((p, i) => (
                        <li key={i}>
                          Dibayar {formatTanggal(p.businessDate)} · {label("payment_method", p.method)} · <MoneyText value={p.amount} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">Belum ada pembayaran.</p>
                  )}
                  {phase3 && inv.disputeStatus === "none" && inv.outstandingAmount > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary">Ajukan sengketa (maks. 7 hari sejak terbit)</summary>
                      <P3ActionForm action={disputeInvoiceAction.bind(null, inv.id)} submitLabel="Ajukan sengketa" variant="outline" className="mt-2 max-w-xl">
                        <TextAreaField label="Keberatan Anda" name="note" required rows={2} />
                      </P3ActionForm>
                    </details>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {phase3 ? (
        <SectionCard title="Dasar royalti (Opsi A)" description="Omzet POS tercatat (transaksi Sah, tanpa void) per outlet per hari yang menjadi dasar royalti bulan itu.">
          <MonthFilter month={royalty[0]?.period ?? (sp.bulan && /^\d{4}-\d{2}$/.test(sp.bulan) ? sp.bulan : toBusinessDate(ctx.now).slice(0, 7))} />
          {royalty.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Tidak ada perhitungan royalti untuk bulan ini (Opsi B tanpa royalti).</p>
          ) : (
            royalty.map((r) => (
              <div key={r.period} className="mt-3 grid gap-2 text-sm">
                <p>
                  Omzet dasar <MoneyText value={r.grossSales} /> × {r.royaltyPercent}% = <strong><MoneyText value={r.royaltyAmount} /></strong> · langganan {r.outletCount} outlet <MoneyText value={r.subscriptionAmount} />
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tanggal</TableHead>
                        <TableHead>Outlet</TableHead>
                        <TableHead className="text-right">Transaksi</TableHead>
                        <TableHead className="text-right">Omzet</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.daily.map((d) => (
                        <TableRow key={`${d.outletCode}:${d.businessDate}`}>
                          <TableCell>{formatTanggal(d.businessDate)}</TableCell>
                          <TableCell>{d.outletCode}</TableCell>
                          <TableCell className="text-right">{num(d.transactions)}</TableCell>
                          <TableCell className="text-right">
                            <MoneyText value={d.sales} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))
          )}
        </SectionCard>
      ) : null}
    </>
  );
}
