import type { Metadata } from "next";
import Link from "next/link";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { M5ActionButton, M5ReasonButton } from "@/components/m5-receivables/action-buttons";
import { FilterForm, FilterSelect, FormInput, FormSelect, FormTextarea, hrefWith } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { evaluateHoldsAction, releaseHoldAction, requestHoldReleaseAction, requestMonthlyBillingAction } from "../actions";

export const metadata: Metadata = { title: "Status kredit" };

/**
 * Status kredit & eksposur (US-M5-03; US-M5-01 KP-3; BR-01/BR-03/BR-06): pelanggan Ditahan (pembukaan pemilik /
 * pengajuan Dispatcher & Admin Keuangan), akan Ditahan, masa transisi, daftar "layak diajukan Tempo", dan cek
 * eksposur per pelanggan. Dispatcher memakai layar ini saat pesanan tempo ditolak.
 */
export default async function CreditStatusPage({ searchParams }: { searchParams: Promise<{ pelanggan?: string }> }) {
  const { ctx } = await requirePermission("m5.credit_exposure.read");
  const sp = await searchParams;
  const [board, eligible, customers] = await Promise.all([m5.creditStatusBoard(ctx), m5.creditEligibleCustomers(ctx), m5.customerOptions(ctx)]);
  const selected = sp.pelanggan ? customers.find((c) => c.id === sp.pelanggan) ?? null : null;
  const [exposure, history] = selected ? await Promise.all([m5.getCreditExposure(ctx, selected.id), m5.creditHistory(ctx, selected.id)]) : [null, []];
  const canRelease = can(ctx, "m5.credit_hold.release");
  const canRequest = can(ctx, "m5.credit_hold.release_request");
  const canEvaluate = can(ctx, "m5.credit_hold.evaluate");
  const canMonthly = can(ctx, "m5.monthly_billing.request");
  const canCard = can(ctx, "m5.aging.read") || can(ctx, "m5.credit_exposure.read");
  const monthlyCandidates = customers.filter((c) => c.isActive && !c.monthlyBilling && (c.creditStatus === "credit" || c.creditStatus === "credit_migrated"));

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Status kredit"
        description={`Posisi ${formatTanggal(board.date)}. Pelanggan Tempo dengan faktur lewat tempo lebih dari ${board.toleranceDays} hari (PAR-09) Ditahan otomatis setiap malam setelah tutup kas; dilepas otomatis saat lunas.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {canEvaluate ? <M5ActionButton label="Hitung ulang Ditahan" action={evaluateHoldsAction} /> : null}
            <ExportButtons excelHref={hrefWith("/api/export/m5.credit_status", { format: "xlsx" })} pdfHref={hrefWith("/api/export/m5.credit_status", { format: "pdf" })} />
          </div>
        }
      />

      <SectionCard title="Cek status & eksposur pelanggan" description="Eksposur = piutang (faktur + belum ditagih) + pesanan tempo berjalan + tempo toko belum difakturkan; satu batas lintas lini (PTB-25).">
        <FilterForm action="/piutang/status-kredit" submitLabel="Lihat" testId="cek-eksposur">
          <FilterSelect name="pelanggan" value={selected?.id} label="Pelanggan" emptyLabel="— pilih pelanggan —" options={customers.map((c) => ({ value: c.id, label: `${c.name}${c.code ? ` (${c.code})` : ""} · ${label("credit_status", c.creditStatus)}` }))} />
        </FilterForm>
        {selected && exposure ? (
          <div className="mt-4 grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{selected.name}</span>
              <StatusBadge enumName="credit_status" value={exposure.creditStatus} />
              {exposure.monthlyBilling ? <ToneBadge tone="info">Tagihan bulanan</ToneBadge> : null}
              {canCard ? (
                <Link href={`/piutang/pelanggan/${selected.id}`} className="text-sm text-primary hover:underline">
                  Kartu piutang
                </Link>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="eksposur-pelanggan">
              <KpiTile label="Saldo piutang" value={<MoneyText value={exposure.balance} />} hint={`Lewat tempo ${formatRupiah(exposure.overdue)}`} />
              <KpiTile label="Eksposur" value={<MoneyText value={exposure.exposure} />} hint={`Pesanan tempo berjalan ${formatRupiah(exposure.openCreditOrders)}`} tone={exposure.exceedsLimit ? "danger" : undefined} />
              <KpiTile label="Batas kredit" value={<MoneyText value={exposure.creditLimit} />} hint={`Tempo ${exposure.paymentTermDays} hari`} />
              <KpiTile label="Sisa batas" value={<MoneyText value={exposure.remaining} />} tone={exposure.remaining < 0 ? "danger" : "success"} />
            </div>
            {history.length ? (
              <ul className="grid gap-1 text-sm">
                {history.slice(0, 5).map((h) => (
                  <li key={h.id}>
                    {formatTanggalJam(h.changedAt)} · {h.fromStatus ? label("credit_status", h.fromStatus) : "—"} → {label("credit_status", h.toStatus)} · {h.changedByName ?? "—"}
                    {h.reason ? <span className="block text-xs text-muted-foreground">{h.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Ditahan" value={String(board.onHold.length)} tone={board.onHold.length ? "danger" : undefined} />
        <KpiTile label="Akan Ditahan" value={String(board.willHold.length)} tone={board.willHold.length ? "warning" : undefined} />
        <KpiTile label="Masa transisi" value={String(board.transition.length)} />
      </div>

      <SectionCard title="Ditahan" description="Pesanan tempo baru diblokir; rit tempo yang belum Berangkat ditandai ke Dispatcher (PTB-27). Pembukaan sebelum lunas hanya pemilik dengan alasan." flush>
        {board.onHold.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-ditahan">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead className="text-right">Lewat tempo</TableHead>
                  <TableHead>Sejak</TableHead>
                  <TableHead>Alasan</TableHead>
                  {canRelease || canRequest ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {board.onHold.map((r) => (
                  <TableRow key={r.customerId} className="align-top">
                    <TableCell>
                      {canCard ? (
                        <Link href={`/piutang/pelanggan/${r.customerId}`} className="font-medium text-primary hover:underline">
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                      <span className="block text-xs text-muted-foreground">{r.code ?? ""} · {label("customer_segment", r.segment)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatRupiah(r.overdueTotal)}
                      {r.worstDaysPastDue ? <span className="block text-xs text-destructive">{r.worstDaysPastDue} hari</span> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{r.lastChangedAt ? formatTanggalJam(r.lastChangedAt) : "—"}</TableCell>
                    <TableCell className="min-w-56 text-sm">{r.lastReason ?? "—"}</TableCell>
                    {canRelease || canRequest ? (
                      <TableCell>
                        {canRelease ? <M5ReasonButton label="Buka Ditahan" title={`Buka status Ditahan ${r.name}?`} description="Berlaku sampai keterlambatan berikutnya." action={releaseHoldAction.bind(null, r.customerId)} variant="default" /> : null}
                        {canRequest ? <M5ReasonButton label="Ajukan pembukaan" title={`Ajukan pembukaan Ditahan ${r.name} ke pemilik?`} action={requestHoldReleaseAction.bind(null, r.customerId)} testId={`ajukan-buka-${r.code ?? r.customerId}`} /> : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada pelanggan Ditahan" compact />
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Akan Ditahan" description="Tagih sebelum tanggal Ditahan." flush>
          {board.willHold.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="daftar-akan-ditahan">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead className="text-right">Lewat tempo</TableHead>
                    <TableHead>Ditahan mulai</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {board.willHold.map((r) => (
                    <TableRow key={r.customerId}>
                      <TableCell className="text-sm">{r.name}</TableCell>
                      <TableCell className="text-right">{formatRupiah(r.overdueTotal)}</TableCell>
                      <TableCell>{formatTanggal(r.holdOn, { weekday: false })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada" compact />
          )}
        </SectionCard>
        <SectionCard title="Masa transisi" description="Penahanan otomatis ditunda pemilik (PAR-41); tetap tampil di laporan lewat tempo." flush>
          {board.transition.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="daftar-masa-transisi">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead className="text-right">Lewat tempo</TableHead>
                    <TableHead>Berakhir</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {board.transition.map((r) => (
                    <TableRow key={r.customerId}>
                      <TableCell className="text-sm">{r.name}</TableCell>
                      <TableCell className="text-right">{formatRupiah(r.overdueTotal)}</TableCell>
                      <TableCell>{r.holdDeferralUntil ? formatTanggal(r.holdDeferralUntil, { weekday: false }) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada" compact />
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Layak diajukan Tempo"
        description="Pelanggan Tunai yang memenuhi syarat lama/volume (PAR-11) dan tanpa masalah (PAR-82). Pengajuan Tempo lewat Data master > Pelanggan (persetujuan pemilik)."
        actions={<ExportButtons excelHref={hrefWith("/api/export/m5.credit_eligible", { format: "xlsx" })} pdfHref={hrefWith("/api/export/m5.credit_eligible", { format: "pdf" })} disabled={!eligible.length} />}
        flush
      >
        {eligible.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="layak-tempo">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Segmen</TableHead>
                  <TableHead className="text-right">Pesanan Selesai</TableHead>
                  <TableHead>Selesai pertama</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eligible.map((r) => (
                  <TableRow key={r.customerId}>
                    <TableCell>
                      <Link href={`/master/pelanggan/${r.customerId}`} className="font-medium text-primary hover:underline">
                        {r.name}
                      </Link>
                      {r.code ? <span className="block text-xs text-muted-foreground">{r.code}</span> : null}
                    </TableCell>
                    <TableCell>{label("customer_segment", r.segment)}</TableCell>
                    <TableCell className="text-right">{r.eligibility.metrics.completedOrders}</TableCell>
                    <TableCell>{r.eligibility.metrics.firstCompletedDate ? formatTanggal(r.eligibility.metrics.firstCompletedDate, { weekday: false }) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada pelanggan Tunai yang memenuhi syarat Tempo" compact />
        )}
      </SectionCard>

      {canMonthly ? (
        <SectionCard title="Ajukan penanda tagihan bulanan" description="Hanya pelanggan Tempo dengan perjanjian tertulis (BR-05); diputuskan pemilik.">
          <M5ActionForm action={requestMonthlyBillingAction} submitLabel="Ajukan ke pemilik" testId="form-tagihan-bulanan-dispatcher" className="max-w-2xl">
            <FormSelect label="Pelanggan" name="customerId" required emptyLabel="— pilih pelanggan Tempo —" options={monthlyCandidates.map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name }))} />
            <FormInput label="Perjanjian tertulis (PDF/foto)" name="agreement" type="file" accept="application/pdf,image/jpeg,image/png" required hint="Wajib (BR-05), maks. 4 MB; foto dikompres otomatis." />
            <FormTextarea label="Alasan" name="reason" required />
          </M5ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
