import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, TextAreaField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumValues, label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { phase3Enabled } from "../_data";
import { createProspectAction } from "../actions";

export const metadata: Metadata = { title: "Calon mitra" };

/**
 * Calon mitra Tahap 3 (US-P3-01 KP-1..KP-3): pendaftaran (portal publik /mitra/daftar atau pembina), survei lokasi,
 * penilaian otomatis (zona & jarak dari sumber air, radius PAR-35, kapasitas PAR-81), persetujuan pemilik.
 */
export default async function ProspectsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission(["p3.partner_prospect.create", "p3.partner.read"]);
  if (!(await phase3Enabled())) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Calon mitra" />
        <Phase3Disabled what="Pendaftaran & penilaian calon mitra" />
      </div>
    );
  }
  const status = sp.status && (enumValues("prospect_status") as string[]).includes(sp.status) ? sp.status : null;
  const rows = await p3.listProspects(ctx, { status });

  return (
    <div className="grid gap-6">
      <PageHeader title="Calon mitra" description="Pendaftaran publik di /mitra/daftar atau dicatat pembina. Lokasi di luar jangkauan zona tarif ditandai tidak layak Fase 1." actions={<ExportButtons excelHref="/api/export/p3.prospects?format=xlsx" />} />
      <nav className="flex flex-wrap gap-2" aria-label="Saring status">
        <Link href="/kemitraan/calon" className={`rounded-full border px-3 py-1 text-sm ${!status ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
          Semua
        </Link>
        {enumValues("prospect_status").map((s) => (
          <Link key={s} href={`/kemitraan/calon?status=${s}`} className={`rounded-full border px-3 py-1 text-sm ${status === s ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
            {label("prospect_status", s)}
          </Link>
        ))}
      </nav>
      <SectionCard title="Daftar calon mitra">
        {rows.length === 0 ? (
          <EmptyState title="Belum ada calon mitra" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-calon-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Nama</TableHead>
                  <TableHead>Alamat usulan</TableHead>
                  <TableHead className="text-right">Jarak rute</TableHead>
                  <TableHead className="text-right">Modal</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dicatat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link href={`/kemitraan/calon/${p.id}`} className="font-medium text-primary hover:underline">
                        {p.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{p.waPhone}</div>
                    </TableCell>
                    <TableCell className="max-w-xs truncate" title={p.proposedAddress}>
                      {p.proposedAddress}
                    </TableCell>
                    <TableCell className="text-right">{p.routeDistanceM !== null ? `${(p.routeDistanceM / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km` : "—"}</TableCell>
                    <TableCell className="text-right">{p.capitalAmount !== null ? <MoneyText value={p.capitalAmount} /> : "—"}</TableCell>
                    <TableCell className="space-x-1">
                      <StatusBadge enumName="prospect_status" value={p.status} />
                      {p.radiusViolation && !p.radiusOverrideReason ? <ToneBadge tone="danger">radius</ToneBadge> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatTanggalJam(p.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      {can(ctx, "p3.partner_prospect.create") ? (
        <SectionCard title="Catat calon mitra" description="Titik lokasi (lintang/bujur) dipakai untuk penilaian zona, jarak rute & radius.">
          <P3ActionForm action={createProspectAction} submitLabel="Catat" testId="form-calon-mitra" className="max-w-3xl">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nama calon mitra" name="name" required />
              <Field label="Badan usaha (opsional)" name="businessEntity" />
              <Field label="Nomor WA" name="waPhone" required inputMode="tel" />
              <Field label="Modal tersedia (Rp)" name="capitalAmount" inputMode="numeric" />
              <Field label="Lintang" name="lat" required inputMode="decimal" placeholder="-6.8200" />
              <Field label="Bujur" name="lng" required inputMode="decimal" placeholder="107.1400" />
            </div>
            <TextAreaField label="Alamat lokasi usulan" name="proposedAddress" required rows={2} />
          </P3ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
