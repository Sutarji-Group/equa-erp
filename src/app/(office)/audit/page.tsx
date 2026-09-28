import { eq, inArray, sql } from "drizzle-orm";
import { ScrollText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NativeSelect, TableScroll } from "@/components/m10-access/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { employees, users } from "@/db/schema";
import { enumOptions, isEnumValue, label } from "@/lib/labels";
import { businessDateToUtcRange, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { describeAudit, queryForActor } from "@/server/core/audit";
import { requirePermission } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";
import { can } from "@/server/core/rbac";
import { listAccessLogs } from "@/server/modules/m10-access";

import { VerifyChainButton } from "./verify-chain-button";

export const metadata: Metadata = { title: "Jejak audit" };

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Jenis objek umum (Bab 5.1) untuk pencarian per objek (US-M10-05 KP-3). */
const OBJECT_TYPES: [string, string][] = [
  ["order", "Pesanan"],
  ["trip", "Rit"],
  ["invoice", "Faktur"],
  ["shift", "Shift"],
  ["deposit", "Setoran"],
  ["discrepancy", "Selisih"],
  ["customer", "Pelanggan"],
  ["product_price", "Harga produk"],
  ["pos_sale", "Transaksi POS"],
  ["journal", "Jurnal"],
  ["user", "Pengguna"],
  ["user_role", "Peran pengguna"],
  ["user_scope", "Lingkup pengguna"],
  ["device", "Perangkat"],
  ["approval_request", "Permintaan persetujuan"],
  ["parameter", "Parameter"],
  ["incident", "Insiden"],
  ["support_ticket", "Laporan kendala"],
];

const ACTIONS: [string, string][] = [
  ["create", "Dibuat"],
  ["update", "Diubah"],
  ["submit", "Diajukan"],
  ["approve", "Disetujui"],
  ["reject", "Ditolak"],
  ["activate", "Diaktifkan"],
  ["deactivate", "Dinonaktifkan"],
  ["revoke", "Dicabut"],
  ["reverse", "Dibalik"],
  ["void", "Di-void"],
  ["close", "Ditutup"],
  ["lock", "Dikunci"],
  ["set", "Ditetapkan"],
  ["expire", "Lewat tenggat"],
  ["overdue", "Ditandai terlambat"],
  ["anonymize", "Dianonimkan"],
];

/**
 * Jejak audit (US-M10-05): pencarian per objek / pengguna / rentang waktu / jenis tindakan, ditampilkan dalam kalimat
 * bahasa lapangan (tindakan sistem berpelaku "Sistem" + aturan pemicu); verifikasi keutuhan rantai hash; ekspor
 * (pemilik). Akuntan hanya objek keuangan; admin sistem tanpa nilai keuangan (diatur `queryForActor`). Tab "Log akses"
 * menampilkan log akses TERPISAH (login/logout, gagal login, perangkat, ekspor, penolakan; KP-4).
 */
export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const { ctx } = await requirePermission("m10.audit_log.read");
  const sp = await searchParams;
  const canAccessLog = can(ctx, "m10.access_log.read");
  const tab = str(sp.tab) === "akses" && canAccessLog ? "akses" : "audit";
  const filters = {
    objectType: str(sp.objek),
    objectId: str(sp.id),
    username: str(sp.pengguna),
    action: str(sp.aksi),
    event: str(sp.kejadian),
    from: str(sp.dari),
    to: str(sp.sampai),
  };
  const canExport = can(ctx, "m10.audit_log.export");

  const tabs = (
    <nav className="mb-4 flex gap-2" aria-label="Jenis catatan">
      <Link href="/audit" className={cn("rounded-md border px-3 py-1.5 text-sm", tab === "audit" && "bg-primary text-primary-foreground")}>
        Jejak audit
      </Link>
      {canAccessLog ? (
        <Link href="/audit?tab=akses" className={cn("rounded-md border px-3 py-1.5 text-sm", tab === "akses" && "bg-primary text-primary-foreground")}>
          Log akses
        </Link>
      ) : null}
    </nav>
  );

  if (tab === "akses") {
    const event = isEnumValue("access_event", filters.event) ? filters.event : undefined;
    const logs = await listAccessLogs(ctx, {
      event,
      username: filters.username || undefined,
      from: isBusinessDate(filters.from) ? filters.from : undefined,
      to: isBusinessDate(filters.to) ? filters.to : undefined,
      limit: 300,
    });
    const qs = new URLSearchParams();
    if (event) qs.set("event", event);
    if (filters.username) qs.set("username", filters.username);
    if (isBusinessDate(filters.from)) qs.set("from", filters.from);
    if (isBusinessDate(filters.to)) qs.set("to", filters.to);
    const q = qs.toString();
    return (
      <>
        <PageHeader
          title="Jejak audit"
          description="Log akses terpisah: masuk/keluar, login gagal, pendaftaran & pemblokiran perangkat, ekspor data, percobaan tindakan yang ditolak. Disimpan 1 tahun (PAR-29)."
          actions={
            can(ctx, "m10.access_log.export") ? (
              <ExportButtons excelHref={`/api/export/m10.access_log?format=xlsx${q ? `&${q}` : ""}`} pdfHref={`/api/export/m10.access_log?format=pdf${q ? `&${q}` : ""}`} />
            ) : null
          }
        />
        {tabs}
        <SectionCard className="mb-6">
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <input type="hidden" name="tab" value="akses" />
            <div className="grid gap-1.5">
              <Label htmlFor="akses-kejadian">Kejadian</Label>
              <NativeSelect id="akses-kejadian" name="kejadian" defaultValue={event ?? ""}>
                <option value="">Semua</option>
                {enumOptions("access_event").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="akses-pengguna">Nama pengguna</Label>
              <Input id="akses-pengguna" name="pengguna" defaultValue={filters.username} placeholder="mis. sopir1" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="akses-dari">Dari tanggal</Label>
              <Input id="akses-dari" name="dari" type="date" defaultValue={filters.from} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="akses-sampai">Sampai tanggal</Label>
              <Input id="akses-sampai" name="sampai" type="date" defaultValue={filters.to} />
            </div>
            <div className="flex items-end">
              <Button type="submit">Cari</Button>
            </div>
          </form>
        </SectionCard>
        {logs.length === 0 ? (
          <EmptyState icon={ScrollText} title="Tidak ada catatan akses" description="Ubah kriteria pencarian." />
        ) : (
          <SectionCard flush>
            <TableScroll>
              <Table data-testid="tabel-log-akses">
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Kejadian</TableHead>
                    <TableHead>Pengguna</TableHead>
                    <TableHead className="hidden md:table-cell">Aturan/izin</TableHead>
                    <TableHead>Keterangan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{formatTanggalJam(l.occurredAt)}</TableCell>
                      <TableCell>
                        <ToneBadge tone={l.success ? "neutral" : "danger"}>{l.eventLabel}</ToneBadge>
                      </TableCell>
                      <TableCell>{l.userName ?? l.usernameAttempted ?? "—"}</TableCell>
                      <TableCell className="hidden font-mono text-xs md:table-cell">{[l.rule, l.permission].filter(Boolean).join(" · ") || "—"}</TableCell>
                      <TableCell className="max-w-md whitespace-normal text-xs">{l.reason ?? (l.ip ? `IP ${l.ip}` : "")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </SectionCard>
        )}
      </>
    );
  }

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
  const knownType = OBJECT_TYPES.some(([k]) => k === filters.objectType);

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
      {tabs}
      <SectionCard className="mb-6">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="grid gap-1.5">
            <Label htmlFor="audit-objek">Jenis objek</Label>
            <NativeSelect id="audit-objek" name="objek" defaultValue={filters.objectType}>
              <option value="">Semua objek</option>
              {!knownType && filters.objectType ? <option value={filters.objectType}>{filters.objectType}</option> : null}
              {OBJECT_TYPES.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </NativeSelect>
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
            <NativeSelect id="audit-aksi" name="aksi" defaultValue={filters.action}>
              <option value="">Semua tindakan</option>
              {ACTIONS.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </NativeSelect>
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
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{formatTanggalJam(r.serverTime)}</span>
                {r.deviceTime ? <span>· waktu perangkat {formatTanggalJam(r.deviceTime)}</span> : null}
                <span>· {label("actor_source", r.source)}</span>
                {r.rule ? <span>· aturan {r.rule}</span> : null}
                <span>
                  · {r.objectType} {r.objectId} · #{r.seq} · {r.hash.slice(0, 12)}
                </span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
