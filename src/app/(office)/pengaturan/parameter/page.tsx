import { inArray, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { employees, users } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam, toBusinessDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";
import * as params from "@/server/core/params";
import { can } from "@/server/core/rbac";

import { ParamEditForm } from "./param-edit-form";

export const metadata: Metadata = { title: "Parameter" };

/** Tampilan nilai terstruktur: `amount: Rp 50.000 · days: 7`. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => {
      if (typeof v === "number" && /amount/.test(k)) return `${k}: ${formatRupiah(v)}`;
      if (typeof v === "boolean") return `${k}: ${v ? "ya" : "tidak"}`;
      if (v === null) return `${k}: —`;
      if (typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    })
    .join(" · ");
}

async function names(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await getDb()
    .select({ id: users.id, name: employees.fullName })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Parameter Lampiran B (US-M10-04 KP-6; 6.2b): daftar PAR dengan nilai berlaku, riwayat per parameter, perubahan hanya
 * oleh pemilik dengan tanggal berlaku (tidak surut) & alasan — berjejak dan diberitahukan.
 */
export default async function ParameterPage({ searchParams }: PageProps<"/pengaturan/parameter">) {
  const { ctx } = await requirePermission("m10.parameter.read");
  const sp = await searchParams;
  const selected = typeof sp.kunci === "string" && params.isParamKey(sp.kunci) ? sp.kunci : null;
  const db = getDb();
  const today = toBusinessDate(ctx.now);
  const current = await params.listCurrent(db, today);
  const canEdit = can(ctx, "m10.parameter.update");
  const history = selected ? await params.history(db, selected) : [];
  const who = await names([...new Set(history.map((h) => h.createdBy).filter((x): x is string => !!x))]);
  const sel = selected ? current.find((c) => c.key === selected) : null;

  return (
    <>
      <PageHeader
        title="Parameter"
        description={
          canEdit
            ? "Ambang & aturan Lampiran B. Perubahan berlaku mulai tanggal yang Anda tetapkan, berjejak, dan diberitahukan ke Admin Keuangan serta peran terdampak."
            : "Ambang & aturan Lampiran B yang berlaku. Hanya pemilik yang dapat mengubah."
        }
      />
      {sel ? (
        <SectionCard
          title={`${sel.key} — ${sel.name}`}
          description={`${sel.reference}${sel.unit ? ` · satuan: ${sel.unit}` : ""}`}
          actions={
            <Link href="/pengaturan/parameter" className="text-sm text-primary underline-offset-4 hover:underline">
              Tutup
            </Link>
          }
          className="mb-6"
        >
          <p className="mb-4 text-sm">
            Nilai berlaku hari ini: <strong>{formatValue(sel.value)}</strong>
            {sel.effectiveFrom ? ` (sejak ${formatTanggal(sel.effectiveFrom)})` : " (bawaan)"}
          </p>
          {canEdit ? (
            <div className="mb-6 rounded-md border p-4">
              <ParamEditForm paramKey={sel.key} value={sel.value} minDate={today} />
            </div>
          ) : null}
          <h3 className="mb-2 text-sm font-semibold">Riwayat</h3>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada perubahan; nilai bawaan Lampiran B berlaku.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Berlaku mulai</TableHead>
                  <TableHead>Nilai</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Oleh</TableHead>
                  <TableHead>Dicatat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{formatTanggal(h.effectiveFrom)}</TableCell>
                    <TableCell className="max-w-md whitespace-normal">{formatValue(h.value)}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal">{h.reason ?? "—"}</TableCell>
                    <TableCell>{h.createdBy ? (who.get(h.createdBy) ?? "—") : "Data awal"}</TableCell>
                    <TableCell>{formatTanggalJam(h.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kode</TableHead>
            <TableHead>Parameter</TableHead>
            <TableHead>Nilai berlaku</TableHead>
            <TableHead className="hidden md:table-cell">Sejak</TableHead>
            <TableHead className="hidden lg:table-cell">Rujukan</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {current.map((p) => (
            <TableRow key={p.key} className={cn(p.key === selected && "bg-accent")}>
              <TableCell className="font-mono text-xs">
                <Link href={`/pengaturan/parameter?kunci=${encodeURIComponent(p.key)}`} className="text-primary underline-offset-4 hover:underline">
                  {p.key}
                </Link>
              </TableCell>
              <TableCell className="max-w-xs whitespace-normal">{p.name}</TableCell>
              <TableCell className="max-w-md whitespace-normal">{formatValue(p.value)}</TableCell>
              <TableCell className="hidden md:table-cell">
                {p.effectiveFrom ? formatTanggal(p.effectiveFrom) : <ToneBadge tone="muted">Bawaan</ToneBadge>}
              </TableCell>
              <TableCell className="hidden max-w-xs whitespace-normal text-xs text-muted-foreground lg:table-cell">{p.reference}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
