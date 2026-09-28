import type { Metadata } from "next";
import Link from "next/link";

import { CashReasonButton } from "@/components/m4-cash/action-buttons";
import { CashActionForm } from "@/components/m4-cash/action-form";
import { Field, FilterForm, LinkTabs, MoneyField, SelectField, TextareaField, hrefWith } from "@/components/m4-cash/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, monthOf } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";

import { reverseSettlementAction, setRestitutionActiveAction, settleRestitutionAction } from "../actions";

export const metadata: Metadata = { title: "Ganti rugi karyawan" };

const STATUS_TONE = { recorded: "warning", partially_settled: "info", settled: "success" } as const;

/**
 * Ganti rugi karyawan (US-M4-03 KP-2..KP-4; BR-11, PTB-22): parameter "ganti rugi aktif" (pemilik), ganti rugi per
 * kejadian (karyawan, tanggal, jumlah, rit/shift, alasan), pelunasan oleh Admin Keuangan (setor tunai / potongan
 * penggajian), saldo per karyawan, rekap bulanan untuk penggajian (Excel/PDF). Sistem tidak memotong gaji.
 */
export default async function RestitutionPage({ searchParams }: { searchParams: Promise<{ tampil?: string; bulan?: string; karyawan?: string }> }) {
  const { ctx } = await requirePermission("m4.restitution.read");
  const sp = await searchParams;
  const view = sp.tampil === "rekap" ? "rekap" : sp.tampil === "semua" ? "semua" : "terbuka";
  const active = await m4.getRestitutionActive(ctx);
  const balances = await m4.restitutionBalances(ctx);
  const isOwner = ctx.roles.includes("owner");
  const outstanding = balances.reduce((s, b) => s + b.outstanding, 0);
  return (
    <div className="grid gap-6">
      <PageHeader
        title="Ganti rugi karyawan"
        description="Selisih kurang yang ditolak pemilik dicatat per kejadian bila ganti rugi aktif. Sistem tidak memotong gaji — rekap bulanan diserahkan ke penggajian."
        meta={active ? <ToneBadge tone="success">Ganti rugi aktif</ToneBadge> : <ToneBadge tone="muted">Ganti rugi belum aktif</ToneBadge>}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Sisa ganti rugi (semua karyawan)" value={<MoneyText value={outstanding} />} tone={outstanding ? "warning" : "success"} />
        <KpiTile label="Karyawan dengan saldo" value={`${balances.filter((b) => b.outstanding > 0).length} orang`} />
        <KpiTile label="Status parameter" value={active ? "Aktif" : "Nonaktif"} hint={active ? "Selisih ditolak → ganti rugi per kejadian" : "Selisih ditolak tercatat tanpa beban ganti rugi (PTB-22)"} />
      </div>
      {isOwner ? (
        <SectionCard title="Parameter ganti rugi aktif" description="Diaktifkan pemilik setelah Peraturan Perusahaan berlaku (BR-11a/b). Perubahan berjejak dan diberitahukan ke Admin Keuangan.">
          <CashActionForm action={setRestitutionActiveAction} submitLabel={active ? "Nonaktifkan ganti rugi" : "Aktifkan ganti rugi"} variant={active ? "outline" : "default"} testId="form-ganti-rugi-aktif">
            <input type="hidden" name="enabled" value={active ? "false" : "true"} />
            <TextareaField label="Alasan" name="reason" required hint="mis. Peraturan Perusahaan No. … berlaku mulai …" />
          </CashActionForm>
        </SectionCard>
      ) : null}

      <SectionCard title="Saldo per karyawan" flush>
        {balances.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="saldo-ganti-rugi">
              <TableHeader>
                <TableRow>
                  <TableHead>Karyawan</TableHead>
                  <TableHead className="text-right">Kejadian</TableHead>
                  <TableHead className="text-right">Tercatat</TableHead>
                  <TableHead className="text-right">Dilunasi</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map((b) => (
                  <TableRow key={b.employeeId}>
                    <TableCell>
                      <Link href={hrefWith("/kas/ganti-rugi", { tampil: "semua", karyawan: b.employeeId })} className="font-medium text-primary hover:underline">
                        {b.employeeName}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{b.employeeNo}</span>
                    </TableCell>
                    <TableCell className="text-right">{b.count}</TableCell>
                    <TableCell className="text-right">{formatRupiah(b.recorded)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(b.settled)}</TableCell>
                    <TableCell className={`text-right font-medium ${b.outstanding ? "text-destructive" : ""}`}>{formatRupiah(b.outstanding)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada ganti rugi tercatat" compact />
        )}
      </SectionCard>

      <LinkTabs
        label="Tampilan ganti rugi"
        active={view}
        tabs={[
          { key: "terbuka", label: "Belum lunas", href: "/kas/ganti-rugi" },
          { key: "semua", label: "Semua kejadian", href: "/kas/ganti-rugi?tampil=semua" },
          { key: "rekap", label: "Rekap bulanan (penggajian)", href: "/kas/ganti-rugi?tampil=rekap" },
        ]}
      />
      {view === "rekap" ? <RecapView ctx={ctx} month={sp.bulan} /> : <ListView ctx={ctx} view={view} employeeId={sp.karyawan ?? null} />}
    </div>
  );
}

async function ListView({ ctx, view, employeeId }: { ctx: ActorContext; view: "terbuka" | "semua"; employeeId: string | null }) {
  const rows = await m4.listRestitutions(ctx, { view: view === "semua" ? "all" : "open", employeeId });
  const canSettle = can(ctx, "m4.restitution.settle");
  const today = ctxBusinessDate(ctx);
  return (
    <SectionCard
      title={view === "semua" ? "Semua kejadian ganti rugi" : "Ganti rugi belum lunas"}
      description={employeeId ? <Link href="/kas/ganti-rugi?tampil=semua" className="text-primary hover:underline">Tampilkan semua karyawan</Link> : undefined}
      actions={<ExportButtons excelHref={hrefWith("/api/export/m4.restitutions", { format: "xlsx", view: view === "semua" ? "all" : "open" })} pdfHref={hrefWith("/api/export/m4.restitutions", { format: "pdf", view: view === "semua" ? "all" : "open" })} />}
      flush
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <Table data-testid="daftar-ganti-rugi">
            <TableHeader>
              <TableRow>
                <TableHead>Kejadian</TableHead>
                <TableHead>Karyawan</TableHead>
                <TableHead className="text-right">Ganti rugi</TableHead>
                <TableHead className="text-right">Sisa</TableHead>
                <TableHead>Status & pelunasan</TableHead>
                <TableHead className="min-w-56" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-80 text-sm">
                    {formatTanggal(r.businessDate, { weekday: false })}
                    <span className="block text-xs text-muted-foreground">{r.reason}</span>
                    {r.depositId && r.depositNumber ? (
                      <Link href={`/kas/setoran/${r.depositId}`} className="text-xs text-primary hover:underline">
                        {r.depositNumber}
                      </Link>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.employeeName}
                    <span className="block text-xs text-muted-foreground">{r.employeeNo}</span>
                  </TableCell>
                  <TableCell className="text-right">{formatRupiah(r.amount)}</TableCell>
                  <TableCell className={`text-right font-medium ${r.outstanding ? "text-destructive" : ""}`}>{formatRupiah(r.outstanding)}</TableCell>
                  <TableCell className="text-sm">
                    <ToneBadge tone={STATUS_TONE[r.status]}>{label("restitution_status", r.status)}</ToneBadge>
                    {r.settlements.map((s) => (
                      <span key={s.id} className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {formatTanggal(s.settledOn, { weekday: false })} · {label("restitution_settlement_method", s.method)} {formatRupiah(s.amount, { signed: s.amount < 0 })}
                        {s.reference ? ` · ${s.reference}` : ""}
                        {canSettle && !s.reversalOfId && !r.reversedSettlementIds.includes(s.id) ? (
                          <CashReasonButton label="Balik" variant="ghost" title="Balik pelunasan ganti rugi" description="Koreksi = pembalik beralasan; di atas batas koreksi perlu persetujuan pemilik (BR-38)." action={reverseSettlementAction.bind(null, s.id)} destructive />
                        ) : null}
                      </span>
                    ))}
                  </TableCell>
                  <TableCell>
                    {r.outstanding > 0 && canSettle ? (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium text-primary">Catat pelunasan</summary>
                        <CashActionForm action={settleRestitutionAction.bind(null, r.id)} submitLabel="Simpan pelunasan" className="mt-2">
                          <MoneyField label="Jumlah (Rp)" name="amount" defaultValue={r.outstanding} required />
                          <SelectField
                            label="Cara"
                            name="method"
                            options={[
                              { value: "cash", label: "Setor tunai karyawan (masuk kas kantor)" },
                              { value: "payroll_deduction", label: "Konfirmasi potongan dari penggajian" },
                            ]}
                            required
                          />
                          <Field label="Tanggal" name="settledOn" type="date" defaultValue={today} max={today} />
                          <Field label="Referensi" name="reference" placeholder="mis. slip gaji Oktober" />
                        </CashActionForm>
                      </details>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title={view === "semua" ? "Belum ada kejadian ganti rugi" : "Semua ganti rugi sudah lunas"} compact />
      )}
    </SectionCard>
  );
}

async function RecapView({ ctx, month }: { ctx: ActorContext; month?: string }) {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : monthOf(ctxBusinessDate(ctx));
  const rows = await m4.restitutionMonthlyRecap(ctx, { month: m });
  const canExport = can(ctx, "m4.restitution.export");
  return (
    <>
      <FilterForm action="/kas/ganti-rugi">
        <input type="hidden" name="tampil" value="rekap" />
        <label className="grid gap-1 text-xs font-medium">
          Bulan
          <input type="month" name="bulan" defaultValue={m} className="h-9 rounded-md border bg-background px-2 text-sm" />
        </label>
      </FilterForm>
      <SectionCard
        title={`Rekap ganti rugi ${m}`}
        description="Per karyawan: kejadian & ganti rugi bulan ini, pelunasan tunai / potongan penggajian, sisa akhir bulan."
        actions={canExport ? <ExportButtons excelHref={hrefWith("/api/export/m4.restitution_recap", { format: "xlsx", month: m })} pdfHref={hrefWith("/api/export/m4.restitution_recap", { format: "pdf", month: m })} /> : null}
        flush
      >
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="rekap-ganti-rugi">
              <TableHeader>
                <TableRow>
                  <TableHead>Karyawan</TableHead>
                  <TableHead className="text-right">Kejadian</TableHead>
                  <TableHead className="text-right">Ganti rugi bulan ini</TableHead>
                  <TableHead className="text-right">Dilunasi tunai</TableHead>
                  <TableHead className="text-right">Potongan penggajian</TableHead>
                  <TableHead className="text-right">Sisa akhir bulan</TableHead>
                  <TableHead>Rincian</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.employeeId}>
                    <TableCell className="text-sm">
                      <span className="font-medium">{r.employeeName}</span>
                      <span className="block text-xs text-muted-foreground">{r.employeeNo}</span>
                    </TableCell>
                    <TableCell className="text-right">{r.incidents}</TableCell>
                    <TableCell className="text-right">{formatRupiah(r.recorded)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(r.settledCash)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(r.settledPayroll)}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(r.outstandingEndOfMonth)}</TableCell>
                    <TableCell className="max-w-72 text-xs text-muted-foreground">{r.details || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada ganti rugi pada bulan ini" compact />
        )}
      </SectionCard>
    </>
  );
}
