import type { Metadata } from "next";
import Link from "next/link";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { M11ActionButton, M11ReasonButton } from "@/components/m11-accounting/action-buttons";
import { FormInput, FormSelect, FormTextarea, PeriodStatusBadge, periodLabel } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { addReviewNoteAction, closePeriodAction, lockPeriodAction, reopenPeriodAction, runAllocationAction, setSharedKeyAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian periode" };

/**
 * Rincian periode (US-M11-10, US-M11-01 KP-3/KP-5, US-M11-04 KP-5): prasyarat tutup dengan tautan tindakan, tutup
 * (Admin Keuangan) → kunci (pemilik) → buka kembali beralasan (pemilik), alokasi L1 & biaya bersama, catatan tinjauan
 * akuntan (bukti TG-8), versi Final laporan.
 */
export default async function PeriodDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m11.period.read");
  const { id } = await params;
  const d = await m11.periodDetail(ctx, /^\d{4}-\d{2}$/.test(id) ? { period: id } : { periodId: id });
  const [allocation, runs] = await Promise.all([m11.allocationStatus(ctx, { periodId: d.period.id }), m11.listRetroactiveRuns(ctx)]);
  const p = d.period;
  const open = p.status === "open" || p.status === "reopened";
  const failing = d.prerequisites.filter((x) => !x.ok);
  const lockRequest = d.lockRequests.find((r) => r.type === "period_lock" && r.status === "submitted");

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={periodLabel(p.period)} />
      <PageHeader
        title={`Periode ${periodLabel(p.period)}`}
        backHref="/akuntansi/periode"
        backLabel="Periode"
        meta={
          <span className="flex flex-wrap gap-1">
            <PeriodStatusBadge status={p.status} late={p.closedLate} />
            {p.revision > 1 ? <ToneBadge tone="warning">Revisi {p.revision}</ToneBadge> : null}
            {p.isRetroactive ? <ToneBadge tone="info">Dibangkitkan retroaktif</ToneBadge> : null}
          </span>
        }
        description={`Batas tutup buku ${formatTanggal(d.deadline)} (BR-32).`}
        actions={
          <div className="flex flex-wrap gap-2" data-testid="aksi-periode">
            <Button asChild variant="outline" size="sm">
              <Link href={`/akuntansi/laporan?periode=${p.period}`}>Laporan keuangan</Link>
            </Button>
            {open && can(ctx, "m11.period.close") ? <M11ActionButton label="Tutup periode" variant="default" action={closePeriodAction.bind(null, p.id)} disabled={d.today <= p.endDate} testId="tutup-periode" /> : null}
            {p.status === "closed" && can(ctx, "m11.period.lock") && lockRequest ? <M11ActionButton label="Kunci periode" variant="default" action={lockPeriodAction.bind(null, p.id)} testId="kunci-periode" /> : null}
            {p.status === "locked" && can(ctx, "m11.period.reopen") ? (
              <M11ReasonButton label="Buka kembali" title={`Buka kembali periode ${p.period}?`} description="Pembukaan berjejak dan diberitahukan ke akuntan; laporan Final saat ini tetap tersimpan sebagai revisi sebelumnya." action={reopenPeriodAction.bind(null, p.id)} minLength={10} destructive />
            ) : null}
          </div>
        }
      />

      <SectionCard title="Prasyarat tutup periode" description={failing.length ? `${failing.length} prasyarat belum terpenuhi.` : "Semua prasyarat terpenuhi."} flush>
        <ul className="divide-y" data-testid="prasyarat-periode">
          {d.prerequisites.map((x) => (
            <li key={x.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm" data-ok={x.ok ? "1" : "0"}>
              <span className="flex items-center gap-2">
                <ToneBadge tone={x.ok ? "success" : "danger"} dot>
                  {x.ok ? "Terpenuhi" : "Belum"}
                </ToneBadge>
                <span>
                  <span className="font-medium">{x.label}</span>
                  <span className="block text-xs text-muted-foreground">{x.detail}</span>
                </span>
              </span>
              {!x.ok ? (
                <Link href={x.href} className="text-primary hover:underline">
                  Kerjakan
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Alokasi biaya" description="L1 → L2/L3 menurut volume pengisian bulan itu (PAR-65); biaya bersama menurut kunci pemilik atau tetap di pusat biaya bersama.">
          <div className="grid gap-4">
            {[allocation.l1, allocation.shared].map((a) => (
              <div key={a.kind} className="grid gap-1 text-sm">
                <p className="font-medium">
                  {label("allocation_kind", a.kind)} — {formatRupiah(a.total)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {Object.entries(a.shares)
                    .map(([pc, v]) => `${pc} ${formatRupiah(v)}`)
                    .join(" · ") || "Tidak ada yang dialokasikan"}
                  {a.message ? ` — ${a.message}` : ""}
                </p>
                {a.posted ? (
                  <ToneBadge tone="success">Terposting</ToneBadge>
                ) : a.required && open && can(ctx, "m11.cost_allocation.run") ? (
                  <div>
                    <M11ActionButton label="Posting alokasi" action={runAllocationAction.bind(null, p.id, a.kind)} testId={`alokasi-${a.kind}`} />
                  </div>
                ) : null}
              </div>
            ))}
            {can(ctx, "m11.cost_allocation.set") ? (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">Kunci alokasi biaya bersama (pemilik)</summary>
                <M11ActionForm action={setSharedKeyAction} submitLabel="Simpan kunci" className="mt-3">
                  <FormSelect
                    label="Dasar"
                    name="basis"
                    options={[
                      { value: "none", label: "Tetap di pusat biaya bersama" },
                      { value: "revenue", label: "Proporsi omzet per lini" },
                      { value: "fixed", label: "Persentase tetap" },
                    ]}
                    defaultValue="none"
                  />
                  <div className="grid grid-cols-4 gap-2">
                    {["L2", "L3", "L4", "L5"].map((pc) => (
                      <FormInput key={pc} label={`${pc} (%)`} name={`pct_${pc}`} inputMode="numeric" />
                    ))}
                  </div>
                  <FormInput label="Alasan" name="reason" required />
                </M11ActionForm>
              </details>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard title="Tinjauan akuntan" description="Laporan bulan pertama setelah cut-over ditinjau akuntan sebagai bukti TG-8; catatan disimpan di periode.">
          {d.notes.length ? (
            <ul className="grid gap-2 text-sm" data-testid="catatan-periode">
              {d.notes.map((n) => (
                <li key={n.id} className="rounded-md border p-2">
                  <span className="text-xs text-muted-foreground">
                    {label("period_review_kind", n.kind)} · {formatTanggalJam(n.createdAt)}
                  </span>
                  <p>{n.note}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Belum ada catatan tinjauan" compact />
          )}
          {can(ctx, "m11.period.review_note") ? (
            <M11ActionForm action={addReviewNoteAction} submitLabel="Simpan catatan" className="mt-3" testId="catatan-akuntan">
              <input type="hidden" name="periodId" value={p.id} />
              <FormSelect label="Jenis" name="kind" options={enumOptions("period_review_kind")} defaultValue="review" />
              <FormTextarea label="Catatan tinjauan" name="note" required rows={3} />
            </M11ActionForm>
          ) : null}
        </SectionCard>
      </div>

      <SectionCard title="Versi Final laporan" description="Tersimpan saat periode dikunci; versi lama tetap tersedia setelah periode dibuka kembali." flush>
        {d.versions.length ? (
          <Table data-testid="versi-final">
            <TableHeader>
              <TableRow>
                <TableHead>Revisi</TableHead>
                <TableHead>Dasar</TableHead>
                <TableHead>Dibuat</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>Revisi {v.revision}</TableCell>
                  <TableCell>{v.scopeKey === "ytd" ? "Kumulatif tahun berjalan" : "Per periode"}</TableCell>
                  <TableCell>{formatTanggalJam(v.generatedAt)}</TableCell>
                  <TableCell>{v.supersededById ? <ToneBadge tone="muted">Digantikan</ToneBadge> : <ToneBadge tone="success">Berlaku</ToneBadge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="Belum ada versi Final" description="Versi Final tersimpan saat pemilik mengunci periode." compact />
        )}
      </SectionCard>

      <SectionCard title="Riwayat periode">
        <KeyValueList
          columns={3}
          items={[
            { label: "Ditutup", value: p.closedAt ? formatTanggalJam(p.closedAt) : "—", hint: p.closedLate ? "Terlambat (setelah batas)" : undefined },
            { label: "Dikunci", value: p.lockedAt ? formatTanggalJam(p.lockedAt) : "—" },
            { label: "Dibuka kembali", value: p.reopenedAt ? formatTanggalJam(p.reopenedAt) : "—", hint: p.reopenReason ?? undefined },
            { label: "Daftar tinjauan pemilik", value: p.manualReviewMarkedAt ? `Ditandai ${formatTanggalJam(p.manualReviewMarkedAt)}` : "Belum ditandai" },
            { label: "Permintaan kunci", value: lockRequest ? <StatusBadge enumName="approval_status" value={lockRequest.status} /> : "—" },
            { label: "Jurnal retroaktif", value: runs.filter((r) => r.periods.includes(p.period)).map((r) => (r.verifiedAt ? "diverifikasi" : "belum diverifikasi")).join(", ") || "—" },
          ]}
        />
      </SectionCard>
      <p className="text-xs text-muted-foreground">
        Nilai jurnal periode dapat dilihat di <Link href={`/akuntansi/jurnal?periode=${p.period}`} className="text-primary hover:underline">daftar jurnal</Link>.
      </p>
    </div>
  );
}
