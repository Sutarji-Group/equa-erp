import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton, ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { FormGrid, TextField } from "@/components/m1-master/fields";
import { ImportSummaryView, type ImportSummaryData } from "@/components/m1-master/import-summary";
import { KeyValueList } from "@/components/shared/key-value-list";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { cancelImportAction, commitImportAction, mergeRowAction, resolveRowAction, updateRowAction } from "../actions";

export const metadata: Metadata = { title: "Laporan validasi impor" };

type Candidate = { source?: string; customerId?: string; code?: string; name?: string; reason?: string };
type Proposal = { action?: string; decision?: string; targetCustomerId?: string; targetCode?: string; targetName?: string; note?: string; reason?: string };

const FILTERS = [
  { value: "masalah", label: "Perlu tindakan / diputuskan" },
  { value: "semua", label: "Semua baris" },
] as const;

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/**
 * Laporan validasi per baris (US-M1-06 KP-2): wajib kosong, format WA salah, segmen tak dikenal, duplikat + usulan
 * penggabungan. Setiap baris Salah diperbaiki atau dikecualikan beralasan sebelum data dapat dimasukkan.
 */
export default async function ImportBatchPage({ params, searchParams }: PageProps<"/master/impor/[id]">) {
  const { ctx } = await requirePermission(["m1.import.create", "m1.import.read"]);
  const { id } = await params;
  const sp = await searchParams;
  const filter = sp.tampil === "semua" ? "semua" : "masalah";
  const { batch, rows, def } = await m1.getImportBatch(ctx, id);
  const open = batch.status !== "committed" && batch.status !== "cancelled";
  const canEdit = open && can(ctx, "m1.import.create");
  const canCommit = open && (def.pricing ? can(ctx, "m1.import.commit_pricing") : can(ctx, "m1.import.commit") || can(ctx, "m1.import.commit_pricing"));
  const blocking = batch.errorCount + batch.duplicateCount;
  // "Perlu tindakan" = Salah, duplikat belum diputuskan, dikecualikan, dan duplikat yang sudah diputuskan (untuk ditinjau).
  const visible = filter === "semua" ? rows : rows.filter((r) => r.status === "error" || r.status === "duplicate" || r.status === "excluded" || Boolean((r.mergeProposal as Proposal | null)?.decision));
  const keyColumns = def.columns.slice(0, 3);

  return (
    <div className="grid gap-6">
      <PageHeader
        title={`Impor ${def.title}`}
        description={`${batch.originalFilename ?? "Berkas"} · diunggah ${formatTanggalJam(batch.createdAt)}`}
        backHref="/master/impor"
        backLabel="Impor data awal"
        meta={
          <div className="flex flex-wrap gap-2">
            <StatusBadge enumName="import_status" value={batch.status} />
            {batch.isInitialData ? <ToneBadge tone="info">Produksi · data awal</ToneBadge> : <ToneBadge tone="neutral">Mode uji</ToneBadge>}
          </div>
        }
        actions={
          <form method="post" action="/api/export/m1.import_validation" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="format" value="xlsx" />
            <input type="hidden" name="batchId" value={batch.id} />
            <input name="purpose" required minLength={5} placeholder="Tujuan ekspor (wajib, BR-39)" className="h-8 w-52 rounded-md border border-input bg-transparent px-2 text-sm" aria-label="Tujuan ekspor" />
            <Button type="submit" variant="outline" size="sm">
              Unduh laporan validasi
            </Button>
          </form>
        }
      />

      <SectionCard title="Ringkasan validasi">
        <KeyValueList
          columns={3}
          items={[
            { label: "Baris", value: batch.rowCount },
            { label: "Salah", value: <span className={batch.errorCount ? "text-destructive" : undefined}>{batch.errorCount}</span> },
            { label: "Duplikat belum diputuskan", value: <span>{batch.duplicateCount}</span> },
            { label: "Dikecualikan (beralasan)", value: batch.excludedCount },
            { label: "Siap dimasukkan", value: Math.max(0, batch.rowCount - batch.errorCount - batch.duplicateCount - batch.excludedCount) },
            { label: "Dimasukkan", value: batch.committedAt ? formatTanggalJam(batch.committedAt) : null },
          ]}
        />
        {open && blocking > 0 ? (
          <Alert className="mt-4" role="status">
            <AlertDescription>Masih ada {blocking} baris yang harus diperbaiki, dikecualikan beralasan, atau diputuskan (duplikat) sebelum data dapat dimasukkan.</AlertDescription>
          </Alert>
        ) : null}
        {batch.status === "committed" && batch.summary ? (
          <div className="mt-4 grid gap-2">
            <h3 className="text-sm font-medium">Hasil impor</h3>
            <ImportSummaryView summary={batch.summary as ImportSummaryData} />
            {batch.isInitialData ? (
              <p className="text-sm text-muted-foreground">
                Data ditandai &quot;data awal&quot;. Pemilik menandatangani ringkasan di{" "}
                <Link href="/master/tanda-tangan" className="text-primary underline-offset-4 hover:underline">
                  Tanda tangan data awal
                </Link>
                .
              </p>
            ) : null}
          </div>
        ) : null}
        {open && (canCommit || canEdit) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {canCommit ? <ActionButton label="Masukkan data" action={commitImportAction.bind(null, batch.id)} disabled={blocking > 0} /> : null}
            {canEdit ? <ReasonActionButton label="Batalkan batch" title="Batalkan batch impor ini?" description="Tidak ada data yang dimasukkan. Unggah ulang berkas yang sudah diperbaiki bila perlu." action={cancelImportAction.bind(null, batch.id)} destructive /> : null}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Baris"
        flush
        actions={
          <nav className="flex gap-1" aria-label="Saring baris">
            {FILTERS.map((f) => (
              <Button key={f.value} asChild size="sm" variant={filter === f.value ? "secondary" : "ghost"}>
                <Link href={`/master/impor/${batch.id}?tampil=${f.value}`}>{f.label}</Link>
              </Button>
            ))}
          </nav>
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14 text-right">Baris</TableHead>
                <TableHead>Isi</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Masalah / kandidat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => {
                const data = r.data as Record<string, unknown>;
                const candidates = (r.duplicateCandidates ?? []) as Candidate[];
                const proposal = (r.mergeProposal ?? null) as Proposal | null;
                return (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="text-right tabular-nums">{r.rowNumber}</TableCell>
                    <TableCell className="min-w-48">
                      {keyColumns.map((c) => (
                        <div key={c.key} className="text-sm">
                          <span className="text-muted-foreground">{c.header}: </span>
                          {show(data[c.key])}
                        </div>
                      ))}
                      {canEdit && (r.status === "error" || r.status === "duplicate") ? (
                        <details className="mt-1 text-sm">
                          <summary className="cursor-pointer text-primary">Perbaiki isi baris</summary>
                          <div className="mt-2">
                            <ActionForm action={updateRowAction.bind(null, batch.id, r.id, def.columns.map((c) => c.key))} submitLabel="Simpan & nilai ulang" resetOnSuccess={false}>
                              <FormGrid>
                                {def.columns.map((c) => (
                                  <TextField key={c.key} label={`${c.header}${c.required ? " *" : ""}`} name={c.key} defaultValue={data[c.key] === null || data[c.key] === undefined ? "" : String(data[c.key])} hint={c.note} />
                                ))}
                              </FormGrid>
                            </ActionForm>
                          </div>
                        </details>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="import_row_status" value={r.status} tone={r.status === "error" ? "danger" : r.status === "duplicate" ? "warning" : r.status === "excluded" ? "muted" : "success"} />
                      {proposal?.decision ? <div className="mt-1 text-xs text-muted-foreground">{proposal.decision === "merge" ? `Digabung ke ${proposal.targetName ?? proposal.targetCode ?? "pelanggan yang ada"}` : "Dibuat baru (beralasan)"}</div> : null}
                    </TableCell>
                    <TableCell className="min-w-64">
                      {r.errors?.length ? (
                        <ul className="list-disc pl-4 text-sm text-destructive">
                          {r.errors.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      ) : null}
                      {r.status === "excluded" ? <p className="text-sm text-muted-foreground">Alasan: {r.exclusionReason ?? "—"}</p> : null}
                      {candidates.length ? (
                        <div className="mt-1 grid gap-1 text-sm">
                          <p className="font-medium">Kandidat duplikat</p>
                          <ul className="grid gap-1">
                            {candidates.map((c, i) => (
                              <li key={i} className="flex flex-wrap items-center gap-2">
                                <span>
                                  {c.code ?? ""} {c.name ?? ""} <span className="text-muted-foreground">({c.reason ?? (c.source === "file" ? "di berkas ini" : "di sistem")})</span>
                                </span>
                                {canEdit && r.status === "duplicate" && c.customerId ? <ActionButton label="Gabungkan ke sini" variant="outline" action={mergeRowAction.bind(null, batch.id, r.id, c.customerId)} /> : null}
                              </li>
                            ))}
                          </ul>
                          {proposal?.note && !proposal.decision ? <p className="text-xs text-muted-foreground">Usulan: {proposal.note}</p> : null}
                        </div>
                      ) : null}
                      {canEdit ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {r.status === "duplicate" && proposal?.targetCode && !candidates.some((c) => c.customerId) ? (
                            <ActionButton label={`Gabungkan ke ${proposal.targetCode}`} variant="outline" action={mergeRowAction.bind(null, batch.id, r.id, null)} />
                          ) : null}
                          {r.status === "duplicate" ? (
                            <ReasonActionButton label="Buat pelanggan baru" title="Tetap buat pelanggan baru?" description="Tulis alasan mengapa ini pelanggan berbeda walau mirip. Keputusan berlaku untuk semua baris dengan kode yang sama." action={resolveRowAction.bind(null, batch.id, r.id, "create_new")} />
                          ) : null}
                          {r.status === "excluded" ? (
                            <ActionButton label="Batalkan pengecualian" variant="outline" action={resolveRowAction.bind(null, batch.id, r.id, "include", "")} />
                          ) : (
                            <ReasonActionButton label="Kecualikan" title={`Kecualikan baris ${r.rowNumber}?`} description="Baris yang dikecualikan tidak dimasukkan. Alasan tercatat di laporan validasi." action={resolveRowAction.bind(null, batch.id, r.id, "exclude")} variant="ghost" />
                          )}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    {filter === "masalah" ? "Tidak ada baris yang perlu tindakan." : "Batch kosong."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      <p className="text-xs text-muted-foreground">Jenis: {label("import_kind", batch.kind)} · {def.description}</p>
    </div>
  );
}
