import type { Metadata } from "next";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { M11ReasonButton } from "@/components/m11-accounting/action-buttons";
import { FilterForm, FilterSelect, FormInput, FormSelect, PROFIT_CENTER_OPTIONS, exportHref } from "@/components/m11-accounting/ui";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { saveMappingAction, setAccountingActiveAction } from "../actions";

export const metadata: Metadata = { title: "Pemetaan jurnal otomatis" };

type Search = Promise<{ status?: string; peristiwa?: string }>;

const RULES = [
  { value: "fixed", label: "Tetap (pusat laba pada pemetaan)" },
  { value: "from_outlet", label: "Dari outlet (depot L3 / toko L4)" },
  { value: "from_source", label: "Dari sumber peristiwa" },
  { value: "split_internal", label: "Transfer internal berpasangan" },
];

/**
 * Pemetaan peristiwa → akun (US-M11-01 KP-2, 7.11.4): dikelola Admin Keuangan (berlaku ke depan, berjejak), akuntan
 * meninjau; semua peristiwa wajib terpetakan sebelum M11 diaktifkan pemilik.
 */
export default async function MappingPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.journal_mapping.read");
  const sp = await searchParams;
  const [view, accounts] = await Promise.all([m11.listMappings(ctx), m11.accountOptions(ctx)]);
  const canEdit = can(ctx, "m11.journal_mapping.update");
  const canActivate = can(ctx, "m11.accounting.activate");
  const rows = view.mappings.filter((m) => (!sp.status || m.status === sp.status) && (!sp.peristiwa || m.event === sp.peristiwa));
  const events = [...new Set(view.mappings.map((m) => m.event))].sort().map((e) => ({ value: e, label: e }));
  const accountOpts = accounts.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }));

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pemetaan jurnal otomatis"
        description="Setiap peristiwa keuangan 7.11.4 dipetakan ke akun debit/kredit & pusat laba. Perubahan berlaku ke depan; jurnal lama dikoreksi lewat jurnal reklasifikasi."
        actions={<ExportButtons excelHref={exportHref("m11.mappings", "xlsx")} pdfHref={exportHref("m11.mappings", "pdf")} />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Pemetaan wajib" value={String(view.mappings.length)} hint={`Berlaku per ${formatTanggal(view.date)}`} />
        <KpiTile label="Belum lengkap" value={String(view.missingCount)} tone={view.missingCount ? "danger" : "success"} hint={view.missingCount ? (view.active ? "Peristiwa tanpa pemetaan masuk daftar tunggu" : "Jurnal otomatis menunggu pemetaan lengkap") : "Semua peristiwa terpetakan"} />
        <KpiTile
          label="Jurnal otomatis M11"
          value={view.active ? "Aktif" : view.activation.flagOn ? "Belum aktif" : "Nonaktif"}
          tone={view.active ? "success" : "warning"}
          hint={
            view.active
              ? "Peristiwa dijurnal saat terjadi"
              : view.activation.flagOn
                ? "Pemetaan wajib belum lengkap — lengkapi lalu aktifkan; peristiwa dibangkitkan retroaktif"
                : "Peristiwa dibangkitkan retroaktif saat diaktifkan"
          }
        />
      </div>

      {canActivate ? (
        <SectionCard title="Aktivasi jurnal otomatis (pemilik)" description="Aktivasi ditolak bila masih ada pemetaan wajib yang hilang atau akunnya nonaktif.">
          <div className="flex flex-wrap gap-2" data-testid="aktivasi-m11">
            {view.active ? (
              <M11ReasonButton label="Nonaktifkan M11" title="Nonaktifkan jurnal otomatis?" description="Peristiwa selama nonaktif dibangkitkan retroaktif saat diaktifkan kembali." action={setAccountingActiveAction.bind(null, false)} destructive />
            ) : (
              <M11ReasonButton label="Aktifkan M11" title="Aktifkan jurnal otomatis?" description="Pastikan semua pemetaan wajib sudah lengkap dan ditinjau akuntan." action={setAccountingActiveAction.bind(null, true)} variant="default" />
            )}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title={`Pemetaan (${rows.length})`}
        flush
        actions={
          <FilterForm action="/akuntansi/pemetaan">
            <FilterSelect name="peristiwa" value={sp.peristiwa} label="Peristiwa" options={events} emptyLabel="Semua" />
            <FilterSelect
              name="status"
              value={sp.status}
              label="Status"
              options={[
                { value: "ok", label: "Lengkap" },
                { value: "missing", label: "Belum ada" },
                { value: "inactive_account", label: "Akun nonaktif" },
              ]}
              emptyLabel="Semua"
            />
          </FilterForm>
        }
      >
        <div className="overflow-x-auto">
          <Table data-testid="tabel-pemetaan">
            <TableHeader>
              <TableRow>
                <TableHead>Peristiwa / entri</TableHead>
                <TableHead>Keterangan</TableHead>
                <TableHead>Debit</TableHead>
                <TableHead>Kredit</TableHead>
                <TableHead>Aturan pusat laba</TableHead>
                <TableHead>Berlaku</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={`${m.event}|${m.entry}`}>
                  <TableCell className="font-mono text-xs">
                    {m.event}
                    <span className="block text-muted-foreground">{m.entry}</span>
                  </TableCell>
                  <TableCell className="max-w-72 text-sm">{m.current?.description ?? m.label}</TableCell>
                  <TableCell className="text-xs">{m.current ? `${m.current.debitCode} ${m.current.debitName} (${m.current.debitProfitCenter ?? "sumber"})` : "—"}</TableCell>
                  <TableCell className="text-xs">{m.current ? `${m.current.creditCode} ${m.current.creditName} (${m.current.creditProfitCenter ?? "sumber"})` : "—"}</TableCell>
                  <TableCell className="text-xs">{m.current ? (RULES.find((r) => r.value === m.current!.profitCenterRule)?.label ?? m.current.profitCenterRule) : "—"}</TableCell>
                  <TableCell className="text-xs">
                    {m.current ? formatTanggal(m.current.effectiveFrom, { weekday: false }) : "—"}
                    {m.history.length > 1 ? <span className="block text-muted-foreground">{m.history.length} versi</span> : null}
                  </TableCell>
                  <TableCell>
                    <ToneBadge tone={m.status === "ok" ? "success" : "danger"} dot>
                      {m.status === "ok" ? "Lengkap" : m.status === "missing" ? "Belum ada" : "Akun nonaktif"}
                    </ToneBadge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {canEdit ? (
        <SectionCard title="Ubah / lengkapi pemetaan" description="Versi baru berlaku mulai tanggal yang dipilih (≥ hari ini). Daftar tunggu peristiwa terkait diproses ulang otomatis.">
          <M11ActionForm action={saveMappingAction} submitLabel="Simpan pemetaan" testId="ubah-pemetaan">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <FormSelect
                label="Peristiwa / entri"
                name="mappingKey"
                required
                options={view.mappings.map((m) => ({ value: `${m.event}|${m.entry}`, label: `${m.event} / ${m.entry}` }))}
                emptyLabel="Pilih peristiwa"
              />
              <FormInput label="Keterangan" name="description" required />
              <FormSelect label="Akun debit" name="debitAccountId" options={accountOpts} required emptyLabel="Pilih akun" />
              <FormSelect label="Akun kredit" name="creditAccountId" options={accountOpts} required emptyLabel="Pilih akun" />
              <FormSelect label="Pusat laba debit" name="debitProfitCenter" options={PROFIT_CENTER_OPTIONS} emptyLabel="Dari sumber" />
              <FormSelect label="Pusat laba kredit" name="creditProfitCenter" options={PROFIT_CENTER_OPTIONS} emptyLabel="Dari sumber" />
              <FormSelect label="Aturan pusat laba" name="profitCenterRule" options={RULES} defaultValue="fixed" />
              <FormInput label="Berlaku mulai" name="effectiveFrom" type="date" required defaultValue={ctxBusinessDate(ctx)} />
              <FormInput label="Alasan perubahan" name="reason" required className="sm:col-span-2" />
            </div>
          </M11ActionForm>
        </SectionCard>
      ) : null}

      <SectionCard title="Peristiwa yang tidak dijurnal" description="Diperlakukan di peristiwa lain agar tidak terjadi posting ganda.">
        <ul className="grid gap-1 text-sm">
          {view.skipped.map((s) => (
            <li key={s.event}>
              <span className="font-mono text-xs">{s.event}</span> — {s.reason}
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
