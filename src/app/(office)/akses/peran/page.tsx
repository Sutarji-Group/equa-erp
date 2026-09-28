import type { Metadata } from "next";

import { TableScroll } from "@/components/m10-access/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import { listDenials, roleMatrixView } from "@/server/modules/m10-access";

export const metadata: Metadata = { title: "Peran & matriks" };

/**
 * Peran & matriks peran × tindakan (US-M10-01 KP-1, US-M10-03 KP-1/KP-2/KP-4): katalog peran tetap, matriks yang dapat
 * diekspor pemilik untuk audit, aturan pemisahan tugas, kombinasi peran terlarang (PTB-31), dan percobaan yang ditolak.
 */
export default async function PeranPage({ searchParams }: PageProps<"/akses/peran">) {
  const { ctx } = await requirePermission("m10.role.read");
  const sp = await searchParams;
  const moduleFilter = typeof sp.modul === "string" ? sp.modul : "";
  const view = roleMatrixView();
  const modules = [...new Map(view.rows.map((r) => [r.module, r.moduleLabel])).entries()];
  const rows = moduleFilter ? view.rows.filter((r) => r.module === moduleFilter) : view.rows;
  const canExport = can(ctx, "m10.role.export");
  const denials = can(ctx, "m10.access_log.read") ? await listDenials(ctx) : null;

  return (
    <>
      <PageHeader
        title="Peran & matriks"
        description="Hak hanya lewat peran dari katalog tetap — tidak ada hak per pengguna. Sistem menolak tindakan yang melanggar pemisahan tugas; tidak ada mode darurat."
        actions={canExport ? <ExportButtons excelHref="/api/export/core.rbac_matrix?format=xlsx" pdfHref="/api/export/core.rbac_matrix?format=pdf" /> : null}
      />

      <SectionCard title="Katalog peran" className="mb-6">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {view.roles.map((r) => (
            <li key={r.code} className="rounded-md border p-3 text-sm">
              <p className="font-medium">{r.label}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {r.requires2fa ? <ToneBadge tone="info">Wajib 2FA</ToneBadge> : null}
                {r.isFieldRole ? <ToneBadge tone="neutral">Lapangan/POS · PIN</ToneBadge> : null}
                {r.isReadOnly ? <ToneBadge tone="muted">Baca-saja</ToneBadge> : null}
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        title="Matriks peran × tindakan"
        description={`${rows.length} tindakan. "Ya" = diizinkan; "Bersyarat" = kernet sebagai pengemudi pengganti (US-M2-11).`}
        actions={
          <form method="get" className="flex items-center gap-2">
            <label htmlFor="matriks-modul" className="sr-only">
              Modul
            </label>
            <select id="matriks-modul" name="modul" defaultValue={moduleFilter} className="h-8 rounded-md border bg-background px-2 text-sm">
              <option value="">Semua modul</option>
              {modules.map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
            <button type="submit" className="h-8 rounded-md border px-3 text-sm">
              Saring
            </button>
          </form>
        }
        flush
      >
        <TableScroll>
          <Table data-testid="matriks-peran">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-56 bg-card">Tindakan</TableHead>
                {view.roles.map((r) => (
                  <TableHead key={r.code} className="text-center text-xs">
                    {r.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="sticky left-0 z-10 whitespace-normal bg-card">
                    <p className="text-sm">{row.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.moduleLabel} · {row.key}
                    </p>
                  </TableCell>
                  {view.roles.map((r) => (
                    <TableCell key={r.code} className="text-center text-xs">
                      {row.grants[r.code] === "Ya" ? "✓" : row.grants[r.code] === "Bersyarat" ? "B" : ""}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </SectionCard>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Aturan pemisahan tugas" description="Diperiksa pada setiap tindakan; pelanggaran ditolak dengan pesan yang menyebut aturannya.">
          <ul className="grid gap-2 text-sm">
            {view.rules.map((r) => (
              <li key={r.code}>
                <span className="font-mono text-xs">{r.code}</span> — {r.title} <span className="text-muted-foreground">({r.ref})</span>
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard title="Kombinasi peran terlarang" description="Tidak dapat diajukan sama sekali (PTB-31).">
          <ul className="grid gap-1 text-sm">
            {view.combos.map((c, i) => (
              <li key={i}>
                {c.roles.join(" + ")} <span className="text-muted-foreground">({c.ref})</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      {denials ? (
        <SectionCard
          title="Percobaan tindakan ditolak (30 hari)"
          description="Lebih dari 3 percobaan sehari oleh pengguna yang sama diberitahukan ke pemilik."
          actions={<ExportButtons excelHref="/api/export/m10.denials?format=xlsx" pdfHref="/api/export/m10.denials?format=pdf" />}
          className="mt-6"
        >
          {denials.byUserDay.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada percobaan yang ditolak.</p>
          ) : (
            <>
              <ul className="mb-4 grid gap-1 text-sm">
                {denials.byUserDay.slice(0, 20).map((d) => (
                  <li key={`${d.userId}-${d.date}`} className="flex flex-wrap items-center gap-2">
                    <span>
                      {formatTanggal(d.date)} · {d.userName ?? "Tidak dikenal"} · {d.count}×
                    </span>
                    {d.alerted ? <ToneBadge tone="danger">Diberitahukan ke pemilik</ToneBadge> : null}
                  </li>
                ))}
              </ul>
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Waktu</TableHead>
                      <TableHead>Pengguna</TableHead>
                      <TableHead>Aturan</TableHead>
                      <TableHead>Pesan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {denials.items.slice(0, 50).map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>{formatTanggalJam(d.occurredAt)}</TableCell>
                        <TableCell>{d.userName ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{d.rule ?? "—"}</TableCell>
                        <TableCell className="max-w-md whitespace-normal text-xs">{d.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </>
          )}
        </SectionCard>
      ) : null}
    </>
  );
}
