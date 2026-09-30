/**
 * M10 — log akses terpisah (US-M10-05 KP-4), percobaan tindakan ditolak (US-M10-03 KP-2), matriks peran × tindakan
 * (US-M10-03 KP-4), dan aturan persetujuan 6.2a yang berlaku (US-M10-04 KP-1/KP-6).
 */
import "server-only";

import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";

import { accessLogs, users } from "@/db/schema";
import { label, type AccessEvent, type RoleCode } from "@/lib/labels";
import { businessDateToUtcRange, toBusinessDate } from "@/lib/time";
import { APPROVAL_TYPES, type ApprovalTypeDef } from "@/server/core/approvals";
import { auditObjectLabel } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { authorize, exportMatrix, sod } from "@/server/core/rbac";

import { userNames } from "./shared";

export type AccessLogFilter = {
  event?: AccessEvent;
  userId?: string;
  username?: string;
  success?: boolean;
  from?: string;
  to?: string;
  limit?: number;
};

export type AccessLogItem = typeof accessLogs.$inferSelect & { userName: string | null; eventLabel: string };

/** Log akses (login/logout, gagal login, perangkat, ekspor, penolakan) — pemilik & admin sistem. */
export async function listAccessLogs(ctx: ActorContext, filter: AccessLogFilter = {}, opts: { tx?: Tx } = {}): Promise<AccessLogItem[]> {
  await authorize(ctx, "m10.access_log.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const where: SQL[] = [sql`(${accessLogs.tenantId} = ${ctx.tenantId} or ${accessLogs.tenantId} is null)`];
  if (filter.event) where.push(eq(accessLogs.event, filter.event));
  if (filter.userId) where.push(eq(accessLogs.userId, filter.userId));
  if (filter.username) {
    const u = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${filter.username.toLowerCase()}`).limit(1);
    if (!u[0]) return [];
    where.push(eq(accessLogs.userId, u[0].id));
  }
  if (filter.success !== undefined) where.push(eq(accessLogs.success, filter.success));
  if (filter.from) where.push(gte(accessLogs.occurredAt, businessDateToUtcRange(filter.from).start));
  if (filter.to) where.push(lt(accessLogs.occurredAt, businessDateToUtcRange(filter.to).end));
  const rows = await tx
    .select()
    .from(accessLogs)
    .where(and(...where))
    .orderBy(desc(accessLogs.occurredAt))
    .limit(Math.min(filter.limit ?? 200, 1000));
  const names = await userNames(tx, rows.map((r) => r.userId));
  return rows.map((r) => ({ ...r, userName: r.userId ? (names.get(r.userId) ?? null) : null, eventLabel: label("access_event", r.event) }));
}

export type DenialSummary = {
  items: AccessLogItem[];
  /** Per pengguna per hari: jumlah percobaan; `alerted` = > 3 (pemilik diberi tahu). */
  byUserDay: { userId: string | null; userName: string | null; date: string; count: number; alerted: boolean }[];
};

/** Percobaan tindakan yang ditolak (pemisahan tugas/peran/lingkup) — 30 hari terakhir. */
export async function listDenials(ctx: ActorContext, opts: { tx?: Tx; days?: number } = {}): Promise<DenialSummary> {
  const from = toBusinessDate(new Date(ctx.now.getTime() - (opts.days ?? 30) * 86_400_000));
  const items = await listAccessLogs(ctx, { event: "action_denied", from, limit: 500 }, opts);
  const map = new Map<string, DenialSummary["byUserDay"][number]>();
  for (const i of items) {
    const date = toBusinessDate(i.occurredAt);
    const key = `${i.userId ?? "-"}:${date}`;
    const cur = map.get(key) ?? { userId: i.userId, userName: i.userName, date, count: 0, alerted: false };
    cur.count++;
    cur.alerted = cur.count > 3;
    map.set(key, cur);
  }
  return { items, byUserDay: [...map.values()].sort((a, b) => b.date.localeCompare(a.date) || b.count - a.count) };
}

/** Matriks peran × tindakan + aturan pemisahan tugas & kombinasi terlarang (murni). */
export function roleMatrixView() {
  const matrix = exportMatrix();
  const combos = sod.FORBIDDEN_ROLE_COMBINATIONS.map((c) => ({ roles: c.roles.map((r) => label("role", r as RoleCode)), ref: c.ref, reason: c.reason }));
  return { ...matrix, rules: Object.values(sod.SOD_RULES), combos };
}

export type ApprovalRuleView = {
  type: string;
  label: string;
  requesters: string[];
  approver: string;
  threshold: string;
  thresholdParam: string | null;
  thresholdValue: unknown;
  deadline: string;
  onExpire: ApprovalTypeDef["onExpire"];
  expireNote: string;
  ref: string;
};

function deadlineText(def: ApprovalTypeDef): string {
  const d = def.deadline;
  switch (d.kind) {
    case "none":
      return "—";
    case "hours":
      return `≤ ${d.hours} jam`;
    case "days":
      return `≤ ${d.days} hari`;
    case "business_days":
      return `≤ ${d.days} hari kerja`;
    case "param_day_of_next_month":
      return `≤ tanggal (${d.param}) bulan berikutnya`;
    case "explicit":
      return d.description;
  }
}

/**
 * Aturan persetujuan 6.2a yang BERLAKU pada tanggal bisnis: pemohon, penyetuju, ambang (nilai parameter saat itu),
 * tenggat, dan perilaku lewat tenggat. Perubahan parameter oleh pemilik langsung mengubah ambang (US-M10-04 KP-6).
 */
export async function describeApprovalRules(tx: Tx, businessDate: string): Promise<ApprovalRuleView[]> {
  const out: ApprovalRuleView[] = [];
  for (const def of APPROVAL_TYPES) {
    const value = def.thresholdParam ? await params.get(tx, def.thresholdParam, businessDate) : null;
    out.push({
      type: def.type,
      label: def.label,
      requesters: def.requesterRoles.map((r) => label("role", r)),
      approver: label("role", def.approverRole),
      threshold: def.thresholdNote,
      thresholdParam: def.thresholdParam ?? null,
      thresholdValue: value,
      deadline: deadlineText(def),
      onExpire: def.onExpire,
      expireNote: def.expireNote,
      ref: def.ref,
    });
  }
  return out;
}

const APPROVAL_NUMBER_KEYS = ["number", "documentNumber", "invoiceNumber", "depositNumber", "tripNumber", "orderNumber", "shiftNumber", "saleNumber", "contractNumber", "customerName", "name"] as const;

/**
 * Teks objek kartu persetujuan (NFR-15/NFR-19, temuan S5B): label jenis objek Bahasa Indonesia + nomor dokumen yang
 * dapat dibaca dari payload persetujuan (mis. "Setoran S-26-000123"); ID teknis (UUID) tidak pernah ditampilkan.
 */
export function approvalObjectText(objectType: string, payload: Record<string, unknown> | null | undefined): string {
  const noun = auditObjectLabel(objectType) ?? "objek";
  const raw = APPROVAL_NUMBER_KEYS.map((k) => payload?.[k]).find((v): v is string => typeof v === "string" && v.trim().length > 0);
  const text = raw ? `${noun} ${raw}` : noun;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
