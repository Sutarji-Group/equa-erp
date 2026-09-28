import { eq, inArray, sql } from "drizzle-orm";
import { ScrollText } from "lucide-react";
import type { Metadata } from "next";

import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { employees, users } from "@/db/schema";
import { label } from "@/lib/labels";
import { businessDateToUtcRange, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { describeAudit, queryForActor } from "@/server/core/audit";
import { requirePermission } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";
import { can } from "@/server/core/rbac";

import { VerifyChainButton } from "./verify-chain-button";

export const metadata: Metadata = { title: "Jejak audit" };

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Jejak audit (US-M10-05): pencarian per objek / pengguna / rentang waktu / jenis tindakan, ditampilkan dalam kalimat
 * bahasa lapangan; verifikasi keutuhan rantai hash; ekspor (pemilik). Akuntan hanya objek keuangan; admin sistem
 * tanpa nilai keuangan (diatur `queryForActor`).
 */
export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const { ctx } = await requirePermission("m10.audit_log.read");
  const sp = await searchParams;
  const filters = {
    objectType: str(sp.objek),
    objectId: str(sp.id),
    username: str(sp.pengguna),
    action: str(sp.aksi),
    from: str(sp.dari),
    to: str(sp.sampai),
  };
  const db = getDb();
  let actorUserId: string | undefined;
  let unknownUser = false;
  if (filters.username) {
    const u = await db.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${filters.username.toLowerCase()}`).limit(1);
    actorUserId = u[0]?.id;
    unknownUser = !actorUserId;
  }
  const rows = unknownUser
    ? []
    : await queryForActor(ctx, {
        objectType: filters.objectType || undefined,
        objectId: filters.objectId || undefined,
        actorUserId,
        action: filters.action || undefined,
        from: isBusinessDate(filters.from) ? businessDateToUtcRange(filters.from).start : undefined,
        to: isBusinessDate(filters.to) ? businessDateToUtcRange(filters.to).end : undefined,
        limit: 200,
      });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const names = new Map(
    actorIds.length
      ? (
          await db
            .select({ id: users.id, name: employees.fullName })
            .from(users)
            .innerJoin(employees, eq(employees.id, users.employeeId))
            .where(inArray(users.id, actorIds))
        ).map((r) => [r.id, r.name])
      : [],
  );
  const exportQuery = new URLSearchParams();
  if (filters.objectType) exportQuery.set("objectType", filters.objectType);
  if (filters.objectId) exportQuery.set("objectId", filters.objectId);
  if (actorUserId) exportQuery.set("actorUserId", actorUserId);
  if (filters.action) exportQuery.set("action", filters.action);
  if (isBusinessDate(filters.from)) exportQuery.set("from", filters.from);
  if (isBusinessDate(filters.to)) exportQuery.set("to", filters.to);
  const qs = exportQuery.toString();
  const canExport = can(ctx, "m10.audit_log.export");

  return (
    <>
      <PageHeader
        title="Jejak audit"
        description="Siapa mengubah apa, kapan, dari nilai berapa ke berapa. Catatan tidak dapat diubah atau dihapus siapa pun."
        actions={
          canExport ? (
            <ExportButtons
              excelHref={`/api/export/core.audit_log?format=xlsx${qs ? `&${qs}` : ""}`}
              pdfHref={`/api/export/core.audit_log?format=pdf${qs ? `&${qs}` : ""}`}
            />
          ) : null
        }
      />
      <SectionCard className="mb-6">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="grid gap-1.5">
            <Label htmlFor="audit-objek">Jenis objek</Label>
            <Input id="audit-objek" name="objek" defaultValue={filters.objectType} placeholder="mis. deposit" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-id">ID objek</Label>
            <Input id="audit-id" name="id" defaultValue={filters.objectId} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-pengguna">Nama pengguna</Label>
            <Input id="audit-pengguna" name="pengguna" defaultValue={filters.username} placeholder="mis. keuangan1" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-aksi">Tindakan</Label>
            <Input id="audit-aksi" name="aksi" defaultValue={filters.action} placeholder="mis. update" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-dari">Dari tanggal</Label>
            <Input id="audit-dari" name="dari" type="date" defaultValue={filters.from} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-sampai">Sampai tanggal</Label>
            <Input id="audit-sampai" name="sampai" type="date" defaultValue={filters.to} />
          </div>
          <div className="flex flex-wrap items-end gap-3 sm:col-span-2 lg:col-span-6">
            <Button type="submit">Cari</Button>
            <VerifyChainButton />
          </div>
        </form>
      </SectionCard>
      {unknownUser ? <p className="mb-4 text-sm text-destructive">Nama pengguna &quot;{filters.username}&quot; tidak ditemukan.</p> : null}
      {rows.length === 0 ? (
        <EmptyState icon={ScrollText} title="Tidak ada catatan" description="Ubah kriteria pencarian." />
      ) : (
        <ol className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-md border bg-card p-3 text-sm">
              <p>{describeAudit(r, { actorName: r.actorUserId ? names.get(r.actorUserId) : null })}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatTanggalJam(r.serverTime)}
                {r.deviceTime ? ` · waktu perangkat ${formatTanggalJam(r.deviceTime)}` : ""} · {label("actor_source", r.source)} · {r.objectType}{" "}
                {r.objectId} · #{r.seq} · {r.hash.slice(0, 12)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
