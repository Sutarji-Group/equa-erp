import { MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { M5ActionButton, M5ReasonButton } from "@/components/m5-receivables/action-buttons";
import { BucketBadge, FilterDate, FilterForm, FormInput, FormTextarea, PiiExportForm } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isUuid } from "@/lib/ids";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { deferHoldAction, endDeferralAction, releaseHoldAction, requestHoldReleaseAction, sendStatementAction } from "../../actions";

export const metadata: Metadata = { title: "Kartu piutang" };

type Search = { dari?: string; sampai?: string };

/**
 * Kartu piutang pelanggan (US-M5-04 KP-2): faktur, pelunasan, uang muka, nota kredit, saldo berjalan; ekspor PDF/Excel
 * dan kirim sebagai pernyataan piutang. Status kredit, eksposur (BR-06), riwayat status (US-M5-03 KP-4), pembukaan
 * Ditahan & masa transisi (US-M5-03 KP-3/KP-5).
 */
export default async function CustomerCardPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission(["m5.aging.read", "m5.credit_exposure.read"]);
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();
  const options = await m5.customerOptions(ctx);
  const customer = options.find((c) => c.id === id);
  if (!customer) notFound();
  const canStatement = can(ctx, "m5.aging.read");
  const canExposure = can(ctx, "m5.credit_exposure.read");
  const [statement, exposure, history, limit] = await Promise.all([
    canStatement ? m5.customerStatement(ctx, id, { from: sp.dari && isBusinessDate(sp.dari) ? sp.dari : null, to: sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : null }) : Promise.resolve(null),
    canExposure ? m5.getCreditExposure(ctx, id) : Promise.resolve(null),
    canExposure ? m5.creditHistory(ctx, id) : Promise.resolve([]),
    canExposure ? m5.holdDeferralLimit(ctx) : Promise.resolve(null),
  ]);
  const onHold = customer.creditStatus === "on_hold";
  const isCredit = customer.creditStatus !== "cash";
  const canRelease = can(ctx, "m5.credit_hold.release");
  const canRequest = can(ctx, "m5.credit_hold.release_request");
  const canDefer = can(ctx, "m5.credit_hold.defer");
  const canSend = can(ctx, "m5.invoice.send");
  const canExport = can(ctx, "m5.aging.export");

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={customer.name} />
      <PageHeader
        title={`Kartu piutang — ${customer.name}`}
        backHref={canStatement ? "/piutang/umur" : "/piutang/status-kredit"}
        backLabel={canStatement ? "Umur piutang" : "Status kredit"}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {customer.code ? <ToneBadge tone="neutral">{customer.code}</ToneBadge> : null}
            <StatusBadge enumName="credit_status" value={customer.creditStatus} />
            {statement?.customer.monthlyBilling ? <ToneBadge tone="info">Tagihan bulanan</ToneBadge> : null}
          </div>
        }
        actions={canSend && statement ? <M5ActionButton label="Kirim pernyataan piutang (WA)" icon={MessageCircle} action={sendStatementAction.bind(null, id)} testId="kirim-pernyataan" /> : null}
      />

      {exposure ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="eksposur">
          <KpiTile label="Saldo piutang" value={<MoneyText value={exposure.balance} />} hint={`Faktur ${formatRupiah(exposure.openInvoices)} + belum ditagih ${formatRupiah(exposure.unbilledCharges)}`} />
          <KpiTile
            label="Eksposur (BR-06)"
            value={<MoneyText value={exposure.exposure} />}
            hint={`+ pesanan tempo berjalan ${formatRupiah(exposure.openCreditOrders)}${exposure.uninvoicedStoreCredit ? ` + tempo toko belum difakturkan ${formatRupiah(exposure.uninvoicedStoreCredit)}` : ""}`}
            tone={exposure.exceedsLimit ? "danger" : undefined}
          />
          <KpiTile label="Batas kredit" value={<MoneyText value={exposure.creditLimit} />} hint={`Tempo ${exposure.paymentTermDays} hari · satu batas lintas lini`} />
          <KpiTile label="Sisa batas" value={<MoneyText value={exposure.remaining} />} tone={exposure.remaining < 0 ? "danger" : "success"} hint={exposure.overdue ? `Lewat tempo ${formatRupiah(exposure.overdue)}` : "Tidak ada yang lewat tempo"} />
        </div>
      ) : null}

      {isCredit && (canRelease || canRequest || canDefer) ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {onHold && (canRelease || canRequest) ? (
            <SectionCard title="Pembukaan status Ditahan" description="Dilepas otomatis saat seluruh faktur lewat tempo lunas. Pembukaan sebelum lunas hanya oleh pemilik dengan alasan, berlaku sampai keterlambatan berikutnya (BR-03).">
              <div className="flex flex-wrap gap-2">
                {canRelease ? <M5ReasonButton label="Buka Ditahan" title="Buka status Ditahan sebelum lunas?" description="Berlaku sampai keterlambatan berikutnya; tercatat di riwayat status kredit." action={releaseHoldAction.bind(null, id)} variant="default" testId="buka-ditahan" /> : null}
                {canRequest ? <M5ReasonButton label="Ajukan pembukaan ke pemilik" title="Ajukan pembukaan Ditahan?" action={requestHoldReleaseAction.bind(null, id)} testId="ajukan-buka-ditahan" /> : null}
              </div>
            </SectionCard>
          ) : null}
          {canDefer && limit ? (
            <SectionCard
              title="Masa transisi (tunda penahanan otomatis)"
              description={`Keputusan langsung pemilik (6.2b), paling lama ${limit.months} bulan sejak go-live${limit.goLive ? ` (${formatTanggal(limit.goLive, { weekday: false })})` : ""}: tanggal berakhir ≤ ${formatTanggal(limit.maxUntil, { weekday: false })}.`}
            >
              <M5ActionForm action={deferHoldAction.bind(null, id)} submitLabel="Tetapkan masa transisi" testId="form-masa-transisi">
                <FormInput label="Berlaku sampai" name="until" type="date" min={limit.today} max={limit.maxUntil} required />
                <FormTextarea label="Alasan" name="reason" required />
              </M5ActionForm>
              <div className="mt-3">
                <M5ReasonButton label="Akhiri masa transisi" title="Akhiri masa transisi sekarang?" action={endDeferralAction.bind(null, id)} size="sm" />
              </div>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {statement ? (
        <>
          <FilterForm action={`/piutang/pelanggan/${id}`} testId="filter-kartu">
            <FilterDate name="dari" value={statement.from} label="Dari" />
            <FilterDate name="sampai" value={statement.to} label="Sampai" />
          </FilterForm>
          <SectionCard
            title="Kartu piutang"
            description={`Saldo sebelumnya ${formatRupiah(statement.openingBalance)} · saldo akhir ${formatRupiah(statement.closingBalance)} · belum ditagih ${formatRupiah(statement.unbilled)} · uang muka tersisa ${formatRupiah(statement.openAdvance)}`}
            actions={canExport ? <PiiExportForm reportKey="m5.customer_card" filters={{ customerId: id, from: statement.from, to: statement.to }} testId="ekspor-kartu" /> : null}
            flush
          >
            {statement.entries.length ? (
              <div className="overflow-x-auto">
                <Table data-testid="kartu-piutang">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tanggal</TableHead>
                      <TableHead>Jenis</TableHead>
                      <TableHead>Nomor</TableHead>
                      <TableHead>Uraian</TableHead>
                      <TableHead className="text-right">Tagihan</TableHead>
                      <TableHead className="text-right">Pembayaran/kredit</TableHead>
                      <TableHead className="text-right">Saldo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.entries.map((e, i) => (
                      <TableRow key={`${e.kind}-${e.reference}-${i}`}>
                        <TableCell className="whitespace-nowrap">{formatTanggal(e.date, { weekday: false })}</TableCell>
                        <TableCell>{label("statement_entry", e.kind)}</TableCell>
                        <TableCell className="whitespace-nowrap">{e.reference}</TableCell>
                        <TableCell className="min-w-56 text-sm">
                          {e.description}
                          {e.info ? <span className="block text-xs text-muted-foreground">{formatRupiah(e.info)}</span> : null}
                        </TableCell>
                        <TableCell className="text-right">{e.debit ? formatRupiah(e.debit) : "—"}</TableCell>
                        <TableCell className="text-right">{e.credit ? formatRupiah(e.credit) : "—"}</TableCell>
                        <TableCell className="text-right font-medium">{formatRupiah(e.balance)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState title="Tidak ada transaksi pada rentang ini" compact />
            )}
          </SectionCard>

          <SectionCard title="Faktur terbuka" flush>
            {statement.openInvoices.length ? (
              <div className="overflow-x-auto">
                <Table data-testid="faktur-terbuka-pelanggan">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Faktur</TableHead>
                      <TableHead>Jatuh tempo</TableHead>
                      <TableHead className="text-right">Sisa</TableHead>
                      <TableHead>Umur</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.openInvoices.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell>
                          <Link href={`/piutang/faktur/${i.id}`} className="font-medium text-primary hover:underline">
                            {i.number}
                          </Link>
                        </TableCell>
                        <TableCell>{formatTanggal(i.dueDate, { weekday: false })}</TableCell>
                        <TableCell className="text-right">{formatRupiah(i.outstanding)}</TableCell>
                        <TableCell>
                          <BucketBadge bucket={i.bucket} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState title="Tidak ada faktur terbuka" compact />
            )}
          </SectionCard>
        </>
      ) : null}

      {canExposure ? (
        <SectionCard title="Riwayat status kredit" description="Kapan, oleh siapa, dan alasannya (US-M5-03 KP-4)." flush>
          {history.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="riwayat-status-kredit">
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Perubahan</TableHead>
                    <TableHead>Oleh</TableHead>
                    <TableHead>Alasan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((h) => (
                    <TableRow key={h.id} className="align-top">
                      <TableCell className="whitespace-nowrap">{formatTanggalJam(h.changedAt)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {h.fromStatus ? label("credit_status", h.fromStatus) : "—"} → {label("credit_status", h.toStatus)}
                      </TableCell>
                      <TableCell>{h.changedByName ?? "—"}</TableCell>
                      <TableCell className="min-w-56 text-sm">
                        {h.reason ?? "—"}
                        {h.rule ? <span className="block text-xs text-muted-foreground">{h.rule}</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Belum ada perubahan status kredit" compact />
          )}
        </SectionCard>
      ) : null}

      {exposure && !statement ? (
        <SectionCard>
          <KeyValueList
            items={[
              { label: "Status kredit", value: label("credit_status", exposure.creditStatus) },
              { label: "Tagihan bulanan", value: exposure.monthlyBilling ? "Ya" : "Tidak" },
            ]}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
