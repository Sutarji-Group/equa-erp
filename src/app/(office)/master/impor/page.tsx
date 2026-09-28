import { FileDown, FileSpreadsheet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m1-master/action-form";
import { FormGrid, SelectField } from "@/components/m1-master/fields";
import { KpiTile } from "@/components/shared/kpi-tile";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { uploadImportAction } from "./actions";

export const metadata: Metadata = { title: "Impor data awal" };

/**
 * Impor data awal (US-M1-06): template & contoh per jenis (KP-1), unggah mode uji/produksi (KP-3), daftar batch dengan
 * laporan validasi (KP-2), status tanda tangan pemilik per kelompok (KP-4) dan kemajuan kunci koordinat (KP-5).
 */
export default async function ImporPage() {
  const { ctx } = await requirePermission(["m1.import.create", "m1.import.read"]);
  const [batches, status] = await Promise.all([m1.listImportBatches(ctx), m1.initialDataStatus(ctx)]);
  const modes = m1.allowedImportModes();
  const canUpload = can(ctx, "m1.import.create");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Impor data awal"
        description="Pelanggan (banyak alamat), harga saat ini per pelanggan, armada, kru, karyawan, depot, sumber air. Tidak ada baris yang masuk sebelum semua kesalahan diselesaikan atau dikecualikan beralasan."
        actions={
          <Button asChild variant="outline">
            <Link href="/master/tanda-tangan">Tanda tangan data awal</Link>
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Alamat terkunci" value={`${status.coordinates.percentLocked}%`} hint={`${status.coordinates.locked}/${status.coordinates.total} alamat · target ${status.coordinates.windowDays} hari pertama${status.coordinates.dayOfWindow ? ` (hari ke-${status.coordinates.dayOfWindow})` : ""}`} />
        {status.groups.map((g) => (
          <KpiTile key={g.group} label={g.label} value={g.status === "signed" ? "Ditandatangani" : g.status === "draft" ? "Menunggu tanda tangan" : "Belum diimpor"} tone={g.status === "signed" ? "success" : g.status === "draft" ? "warning" : undefined} />
        ))}
      </div>

      <SectionCard title="Template & contoh terisi" description="Isi lembar Data mulai baris 2; kolom bertanda * wajib.">
        <ul className="grid gap-2 sm:grid-cols-2">
          {m1.IMPORT_KINDS_M1.map((k) => (
            <li key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
              <div>
                <p className="font-medium">{m1.IMPORT_DEFS[k].title}</p>
                <p className="text-xs text-muted-foreground">{m1.IMPORT_DEFS[k].description}</p>
              </div>
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm">
                  <a href={`/master/impor/template/${k}`} download>
                    <FileSpreadsheet aria-hidden />
                    Template
                  </a>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <a href={`/master/impor/template/${k}?contoh=1`} download>
                    <FileDown aria-hidden />
                    Contoh
                  </a>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      {canUpload ? (
        <SectionCard title="Unggah berkas" description="Mode uji dapat diulang (lingkungan uji). Mode produksi hanya sekali per jenis dan menandai data sebagai &quot;data awal&quot; (hanya diubah lewat koreksi berjejak).">
          <ActionForm action={uploadImportAction} submitLabel="Unggah & validasi" aria-label="Unggah berkas impor">
            <FormGrid>
              <SelectField label="Jenis data" name="kind" required options={m1.IMPORT_KINDS_M1.map((k) => ({ value: k, label: m1.IMPORT_DEFS[k].title }))} placeholder="— Pilih jenis —" />
              <SelectField label="Mode" name="mode" options={modes.map((m) => ({ value: m, label: m === "test" ? "Uji (dapat diulang)" : "Produksi (sekali, data awal)" }))} />
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="f-file">Berkas Excel (.xlsx)</Label>
                <Input id="f-file" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
              </div>
            </FormGrid>
          </ActionForm>
        </SectionCard>
      ) : null}

      <SectionCard title="Riwayat impor" flush>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Waktu</TableHead>
                <TableHead>Jenis</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Baris</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Salah / duplikat / dikecualikan</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/master/impor/${b.id}`} className="text-primary underline-offset-4 hover:underline">
                      {formatTanggalJam(b.createdAt)}
                    </Link>
                    <div className="text-xs text-muted-foreground">{b.originalFilename ?? ""}</div>
                  </TableCell>
                  <TableCell>{label("import_kind", b.kind)}</TableCell>
                  <TableCell>{b.isInitialData ? <ToneBadge tone="info">Produksi</ToneBadge> : <ToneBadge tone="neutral">Uji</ToneBadge>}</TableCell>
                  <TableCell className="text-right">{b.rowCount}</TableCell>
                  <TableCell className="hidden sm:table-cell text-right">
                    {b.errorCount} / {b.duplicateCount} / {b.excludedCount}
                  </TableCell>
                  <TableCell>
                    <StatusBadge enumName="import_status" value={b.status} tone={b.status === "committed" ? "success" : b.status === "has_errors" ? "danger" : b.status === "validated" ? "info" : "muted"} />
                  </TableCell>
                </TableRow>
              ))}
              {batches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    Belum ada impor.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
