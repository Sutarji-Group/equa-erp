import type { Metadata } from "next";
import Link from "next/link";

import { CashActionButton, CashReasonButton } from "@/components/m4-cash/action-buttons";
import { CashActionForm } from "@/components/m4-cash/action-form";
import { DateFilterInput, FilterForm, LinkTabs, SelectField, SelectFilterInput, TextareaField, hrefWith } from "@/components/m4-cash/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import type { ActorContext } from "@/server/core/context";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";

import { approveDiscrepancyAction, completeFollowUpAction, explainDiscrepancyAction, rejectDiscrepancyAction, reopenDiscrepancyAction } from "../actions";

export const metadata: Metadata = { title: "Selisih" };

type Search = { tampil?: string; dari?: string; sampai?: string; id?: string; bulan?: string };

/**
 * Selisih (US-M4-03; US-M4-06 KP-6): daftar terbuka dengan umur (lewat batas tindak lanjut di atas & disorot, KPI-03),
 * keputusan pemilik satu ketuk (Setujui) / Tolak beralasan → kembali ke Admin Keuangan, penjelasan & tindak lanjut Admin
 * Keuangan, buka kembali selisih di bawah ambang (≤ 7 hari), riwayat per sopir/operator dengan deret hari tanpa selisih.
 */
export default async function DiscrepanciesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m4.discrepancy.read");
  const sp = await searchParams;
  const view = sp.tampil === "riwayat" ? "riwayat" : sp.tampil === "semua" ? "semua" : "terbuka";
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Selisih"
        description="Selisih setoran & kas: alasan dari Admin Keuangan, keputusan pemilik untuk selisih ≥ ambang (≤ 24 jam), tindak lanjut & ganti rugi."
      />
      <LinkTabs
        label="Tampilan selisih"
        active={view}
        tabs={[
          { key: "terbuka", label: "Terbuka", href: "/kas/selisih" },
          { key: "semua", label: "Semua", href: "/kas/selisih?tampil=semua" },
          { key: "riwayat", label: "Riwayat per karyawan", href: "/kas/selisih?tampil=riwayat" },
        ]}
      />
      {view === "riwayat" ? <HistoryView ctx={ctx} months={Number(sp.bulan) || 6} /> : <ListView ctx={ctx} view={view} sp={sp} />}
    </div>
  );
}

async function ListView({ ctx, view, sp }: { ctx: ActorContext; view: "terbuka" | "semua"; sp: Search }) {
  const today = ctxBusinessDate(ctx);
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : view === "semua" ? addDays(to, -30) : null;
  const res = await m4.listDiscrepancies(ctx, { view: view === "semua" ? "all" : "open", from, to: view === "semua" ? to : null, id: sp.id ?? null });
  const canDecide = can(ctx, "m4.discrepancy.decide");
  const canExplain = can(ctx, "m4.discrepancy.explain");
  const canReopen = can(ctx, "m4.discrepancy.reopen");
  const waitingOwner = res.rows.filter((r) => r.requiresOwnerDecision && !r.decision && r.status !== "done").length;
  const shortage = res.rows.filter((r) => r.status !== "done" && r.amount < 0).reduce((s, r) => s + r.amount, 0);
  const reasonOptions = enumOptions("discrepancy_reason");
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Belum Selesai" value={`${res.rows.filter((r) => r.status !== "done").length} selisih`} hint={<MoneyText value={shortage} signed />} />
        <KpiTile label={`Lewat ${res.followUpHours} jam (KPI-03)`} value={`${res.overdueCount} selisih`} tone={res.overdueCount ? "danger" : "success"} />
        <KpiTile label="Menunggu keputusan pemilik" value={`${waitingOwner} selisih`} tone={waitingOwner ? "warning" : "success"} />
      </div>
      {view === "semua" ? (
        <FilterForm action="/kas/selisih">
          <input type="hidden" name="tampil" value="semua" />
          <DateFilterInput name="dari" value={from} label="Dari" />
          <DateFilterInput name="sampai" value={to} label="Sampai" />
        </FilterForm>
      ) : null}
      <SectionCard
        title={sp.id ? "Selisih terpilih" : view === "semua" ? "Semua selisih" : "Selisih terbuka"}
        description={sp.id ? <Link href="/kas/selisih" className="text-primary hover:underline">Tampilkan semua selisih terbuka</Link> : "Selisih lewat batas tindak lanjut tampil paling atas."}
        actions={
          <ExportButtons
            excelHref={hrefWith("/api/export/m4.discrepancies", { format: "xlsx", view: view === "semua" ? "all" : "open", from: from ?? addDays(to, -30), to })}
            pdfHref={hrefWith("/api/export/m4.discrepancies", { format: "pdf", view: view === "semua" ? "all" : "open", from: from ?? addDays(to, -30), to })}
          />
        }
        flush
      >
        {res.rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-selisih">
              <TableHeader>
                <TableRow>
                  <TableHead>Sumber</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Umur</TableHead>
                  <TableHead className="min-w-56">Tindakan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {res.rows.map((r) => {
                  const decidable = r.requiresOwnerDecision && !r.decision && r.status === "explained";
                  const explainable = !r.decision && (r.status === "formed" || r.status === "explained");
                  const followUp = r.status === "rejected" || r.status === "followed_up";
                  return (
                    <TableRow key={r.id} className={r.overdue ? "bg-destructive/5" : r.id === sp.id ? "bg-muted/50" : undefined} data-overdue={r.overdue ? "true" : undefined}>
                      <TableCell>
                        <span className="font-medium">{r.sourceLabel}</span>
                        <span className="block text-xs text-muted-foreground">
                          {formatTanggal(r.businessDate, { weekday: false })}
                          {r.depositNumber && r.depositId ? (
                            <>
                              {" · "}
                              <Link href={`/kas/setoran/${r.depositId}`} className="text-primary hover:underline">
                                {r.depositNumber}
                              </Link>
                            </>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className={`text-right font-semibold ${r.amount < 0 ? "text-destructive" : "text-success"}`}>{formatRupiah(r.amount, { signed: true })}</TableCell>
                      <TableCell className="max-w-64 text-sm">
                        {r.reason ? label("discrepancy_reason", r.reason) : <span className="text-destructive">Belum dijelaskan</span>}
                        {r.explanation ?? r.reasonNote ? <span className="block text-xs text-muted-foreground">{r.explanation ?? r.reasonNote}</span> : null}
                        {r.decisionReason ? <span className="block text-xs">Keputusan: {r.decisionReason}</span> : null}
                        {r.followUpNote ? <span className="block text-xs">Tindak lanjut: {r.followUpNote}</span> : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <StatusBadge enumName="discrepancy_status" value={r.status} />
                          {r.requiresOwnerDecision ? <ToneBadge tone="info">≥ ambang — pemilik</ToneBadge> : <ToneBadge tone="muted">Di bawah ambang</ToneBadge>}
                          {r.locksTrips ? <ToneBadge tone="danger">Mengunci rit sopir</ToneBadge> : null}
                          {r.approvalNumber ? (
                            <span className="text-xs text-muted-foreground">
                              {r.approvalNumber}
                              {r.approvalDeadlineAt ? ` · tenggat ${formatTanggalJam(r.approvalDeadlineAt)}` : ""}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className={`text-sm ${r.overdue ? "font-semibold text-destructive" : ""}`}>
                        {r.ageHours} jam{r.overdue ? " — lewat batas" : ""}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {decidable && canDecide ? (
                            <>
                              <CashActionButton label="Setujui" action={approveDiscrepancyAction.bind(null, r.id)} testId={`setujui-${r.id}`} />
                              <CashReasonButton
                                label="Tolak"
                                title="Tolak penjelasan selisih"
                                description="Selisih dikembalikan ke Admin Keuangan untuk ditindaklanjuti; bila ganti rugi aktif, selisih kurang dicatat sebagai ganti rugi karyawan."
                                action={rejectDiscrepancyAction.bind(null, r.id)}
                                destructive
                                testId={`tolak-${r.id}`}
                              />
                            </>
                          ) : null}
                          {r.canReopen && canReopen ? (
                            <CashReasonButton label="Buka kembali" title="Buka kembali selisih di bawah ambang" description="Selisih yang ditutup Admin Keuangan dapat dibuka kembali pemilik dalam 7 hari, lalu diputuskan." action={reopenDiscrepancyAction.bind(null, r.id)} />
                          ) : null}
                          {followUp && canExplain ? (
                            <CashReasonButton label="Selesaikan tindak lanjut" title="Tindak lanjut selisih ditolak" description="Catat tindak lanjut ke karyawan (sistem tidak memotong gaji)." textLabel="Catatan tindak lanjut" action={completeFollowUpAction.bind(null, r.id)} />
                          ) : null}
                        </div>
                        {explainable && canExplain ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-sm font-medium text-primary">{r.status === "formed" ? "Jelaskan selisih" : "Perbarui penjelasan"}</summary>
                            <CashActionForm action={explainDiscrepancyAction.bind(null, r.id)} submitLabel="Simpan penjelasan" className="mt-2">
                              <SelectField label="Alasan" name="reason" options={reasonOptions} defaultValue={r.reason} emptyLabel="Pilih alasan…" required />
                              <TextareaField label="Penjelasan" name="explanation" defaultValue={r.explanation} required />
                            </CashActionForm>
                          </details>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title={view === "semua" ? "Tidak ada selisih pada rentang ini" : "Tidak ada selisih terbuka"} compact />
        )}
      </SectionCard>
    </>
  );
}

async function HistoryView({ ctx, months }: { ctx: ActorContext; months: number }) {
  const m = Math.min(Math.max(months, 1), 24);
  const res = await m4.discrepancyHistory(ctx, { months: m });
  return (
    <>
      <FilterForm action="/kas/selisih">
        <input type="hidden" name="tampil" value="riwayat" />
        <SelectFilterInput
          name="bulan"
          value={String(m)}
          label="Rentang"
          options={[3, 6, 12].map((n) => ({ value: String(n), label: `${n} bulan terakhir` }))}
        />
      </FilterForm>
      <SectionCard
        title="Deret hari tanpa selisih"
        description={`Dasar insentif nihil selisih: tanpa selisih selama ${res.zeroMonths} bulan (BR-12).`}
        flush
      >
        {res.streaks.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="deret-nihil-selisih">
              <TableHeader>
                <TableRow>
                  <TableHead>Karyawan</TableHead>
                  <TableHead className="text-right">Hari setor tanpa selisih</TableHead>
                  <TableHead>Selisih terakhir</TableHead>
                  <TableHead>Nihil {res.zeroMonths} bulan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {res.streaks.map((s) => (
                  <TableRow key={s.employeeId}>
                    <TableCell className="font-medium">{s.employeeName}</TableCell>
                    <TableCell className="text-right">{s.daysWithoutDiscrepancy}</TableCell>
                    <TableCell className="text-sm">{s.lastDiscrepancyDate ? formatTanggal(s.lastDiscrepancyDate, { weekday: false }) : "—"}</TableCell>
                    <TableCell>{s.zeroForMonths ? <ToneBadge tone="success">Memenuhi</ToneBadge> : <ToneBadge tone="muted">Belum</ToneBadge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada setoran pada rentang ini" compact />
        )}
      </SectionCard>
      <SectionCard
        title="Selisih per karyawan per bulan"
        actions={<ExportButtons excelHref={hrefWith("/api/export/m4.discrepancy_history", { format: "xlsx", months: String(m) })} pdfHref={hrefWith("/api/export/m4.discrepancy_history", { format: "pdf", months: String(m) })} />}
        flush
      >
        {res.rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-selisih">
              <TableHeader>
                <TableRow>
                  <TableHead>Bulan</TableHead>
                  <TableHead>Karyawan</TableHead>
                  <TableHead className="text-right">Kejadian</TableHead>
                  <TableHead className="text-right">Kurang</TableHead>
                  <TableHead className="text-right">Lebih</TableHead>
                  <TableHead>Alasan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {res.rows.map((r) => (
                  <TableRow key={`${r.employeeId}-${r.month}`}>
                    <TableCell>{r.month}</TableCell>
                    <TableCell className="font-medium">{r.employeeName}</TableCell>
                    <TableCell className="text-right">{r.count}</TableCell>
                    <TableCell className="text-right text-destructive">{r.shortage ? formatRupiah(r.shortage) : "—"}</TableCell>
                    <TableCell className="text-right">{r.surplus ? formatRupiah(r.surplus) : "—"}</TableCell>
                    <TableCell className="text-sm">
                      {Object.entries(r.reasons)
                        .map(([k, n]) => `${label("discrepancy_reason", k)} ×${n}`)
                        .join(", ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada selisih pada rentang ini" compact />
        )}
      </SectionCard>
    </>
  );
}
