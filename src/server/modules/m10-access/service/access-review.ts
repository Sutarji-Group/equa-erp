/**
 * M10 — tinjauan hak akses kuartalan (US-M10-01 KP-6; R09; PAR-47) & ringkasan perubahan akses harian (KP-7).
 *
 * - `accessReviewList(ctx, quarter?)` — daftar pengguna, peran (dengan masa berlaku), lingkup, terakhir login; penanda
 *   "tanpa login > N hari" (parameter `access.review_inactive_days`, bawaan 60) dan "multi-peran lewat masa berlaku".
 * - `markAccessReviewed(ctx, { quarter, notes })` — pemilik menandai "ditinjau" per kuartal (snapshot disimpan).
 * - `dailyAccessSummary(now)` — job: perubahan pengguna/peran/lingkup/perangkat hari ini → notifikasi pemilik
 *   `access.daily_summary` (ikut ringkasan e-mail harian PAR-55).
 */
import "server-only";

import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import { accessReviews, auditLogs, employees, userRoles, users, userScopes } from "@/db/schema";
import { label, type RoleCode } from "@/lib/labels";
import { addDays, businessDateToUtcRange, formatTanggal, toBusinessDate, toWibParts } from "@/lib/time";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { ConflictError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { quarterOf, quarterRange, scopeLabels } from "./shared";

export type AccessReviewFlag = "no_login" | "multi_role_expired" | "multi_role";

export type AccessReviewItem = {
  userId: string;
  username: string;
  fullName: string;
  employeeNo: string;
  status: string;
  roles: { role: RoleCode; label: string; validUntil: string | null; expired: boolean }[];
  scopes: string[];
  lastLoginAt: string | null;
  daysSinceLogin: number | null;
  flags: AccessReviewFlag[];
};

export type AccessReviewView = {
  quarter: string;
  range: { start: string; end: string };
  inactiveDays: number;
  items: AccessReviewItem[];
  flaggedCount: number;
  review: typeof accessReviews.$inferSelect | null;
  history: (typeof accessReviews.$inferSelect)[];
};

async function buildItems(tx: Tx, tenantId: string, today: string, now: Date): Promise<{ items: AccessReviewItem[]; inactiveDays: number }> {
  const { days: inactiveDays } = await params.get(tx, "access.review_inactive_days", today);
  const rows = await tx
    .select({ user: users, fullName: employees.fullName, employeeNo: employees.employeeNo })
    .from(users)
    .innerJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(users.tenantId, tenantId), inArray(users.status, ["active", "locked", "pending_approval"])))
    .orderBy(employees.fullName);
  const ids = rows.map((r) => r.user.id);
  const roles = ids.length ? await tx.select().from(userRoles).where(and(inArray(userRoles.userId, ids), eq(userRoles.status, "active"))) : [];
  const scopes = ids.length ? await tx.select().from(userScopes).where(and(inArray(userScopes.userId, ids), eq(userScopes.status, "active"))) : [];
  const labels = await scopeLabels(tx, scopes.map((s) => ({ type: s.scopeType, refId: s.refId })));
  const items = rows.map(({ user, fullName, employeeNo }) => {
    const myRoles = roles
      .filter((r) => r.userId === user.id)
      .map((r) => ({ role: r.role as RoleCode, label: label("role", r.role), validUntil: r.validUntil, expired: !!r.validUntil && r.validUntil < today }));
    const reference = user.lastLoginAt ?? user.activatedAt ?? user.createdAt;
    const daysSinceLogin = user.lastLoginAt ? Math.floor((now.getTime() - user.lastLoginAt.getTime()) / 86_400_000) : null;
    const flags: AccessReviewFlag[] = [];
    if (user.status !== "pending_approval" && now.getTime() - reference.getTime() > inactiveDays * 86_400_000) flags.push("no_login");
    if (myRoles.length > 1) flags.push("multi_role");
    if (myRoles.some((r) => r.expired)) flags.push("multi_role_expired");
    return {
      userId: user.id,
      username: user.username,
      fullName,
      employeeNo,
      status: user.status,
      roles: myRoles,
      scopes: scopes.filter((s) => s.userId === user.id).map((s) => labels.get(`${s.scopeType}:${s.refId}`) ?? s.refId),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      daysSinceLogin,
      flags,
    };
  });
  return { items, inactiveDays };
}

/** Daftar tinjauan hak akses untuk kuartal (bawaan kuartal berjalan). */
export async function accessReviewList(ctx: ActorContext, quarter?: string, opts: { tx?: Tx } = {}): Promise<AccessReviewView> {
  await authorize(ctx, "m10.access_review.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const q = quarter ?? quarterOf(today);
  const range = quarterRange(q);
  const { items, inactiveDays } = await buildItems(tx, ctx.tenantId, today, ctx.now);
  const history = await tx.select().from(accessReviews).where(eq(accessReviews.tenantId, ctx.tenantId)).orderBy(desc(accessReviews.quarter)).limit(12);
  return {
    quarter: q,
    range,
    inactiveDays,
    items,
    flaggedCount: items.filter((i) => i.flags.some((f) => f !== "multi_role")).length,
    review: history.find((h) => h.quarter === q) ?? null,
    history,
  };
}

const markSchema = z.object({
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/, { error: "Kuartal harus berformat YYYY-Qn." }),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** Pemilik menandai tinjauan kuartal "ditinjau" (snapshot daftar & penanda disimpan). */
export async function markAccessReviewed(ctx: ActorContext, input: z.input<typeof markSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.access_review.mark", { tx: opts.tx, objectType: "access_review" });
  const data = parseInput(markSchema, input, { quarter: "Kuartal", notes: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const today = ctxBusinessDate(ctx);
    if (quarterRange(data.quarter).start > today) throw new ConflictError("QUARTER_NOT_STARTED", "Kuartal itu belum dimulai.");
    const existing = await tx
      .select()
      .from(accessReviews)
      .where(and(eq(accessReviews.tenantId, ctx.tenantId), eq(accessReviews.quarter, data.quarter)))
      .limit(1);
    if (existing[0]?.status === "reviewed") throw new ConflictError("ACCESS_REVIEW_DONE", `Tinjauan ${data.quarter} sudah ditandai ditinjau.`);
    const { items, inactiveDays } = await buildItems(tx, ctx.tenantId, today, ctx.now);
    const flagged = items.filter((i) => i.flags.some((f) => f !== "multi_role"));
    const snapshot = { takenAt: ctx.now.toISOString(), inactiveDays, count: items.length, items };
    const flaggedJson = { count: flagged.length, users: flagged.map((f) => ({ userId: f.userId, username: f.username, flags: f.flags })) };
    const [row] = existing[0]
      ? await tx
          .update(accessReviews)
          .set({ snapshot, flagged: flaggedJson, status: "reviewed", reviewedBy: ctx.userId, reviewedAt: ctx.now, notes: data.notes ?? null, updatedAt: ctx.now })
          .where(eq(accessReviews.id, existing[0].id))
          .returning()
      : await tx
          .insert(accessReviews)
          .values({ tenantId: ctx.tenantId, quarter: data.quarter, snapshot, flagged: flaggedJson, status: "reviewed", reviewedBy: ctx.userId, reviewedAt: ctx.now, notes: data.notes ?? null })
          .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "access_review",
      objectId: row!.id,
      action: "approve",
      after: { quarter: data.quarter, users: items.length, flagged: flagged.length, status: "reviewed" },
      reason: data.notes ?? null,
      rule: "PAR-47",
    });
    return row!;
  });
}

/** Job bulanan: pada bulan terakhir kuartal, ingatkan pemilik bila tinjauan kuartal berjalan belum dilakukan (PAR-47). */
export async function remindAccessReview(now: Date = new Date(), db?: Db): Promise<{ reminded: number }> {
  const today = toBusinessDate(now);
  const { month } = toWibParts(now);
  const { frequency } = await params.get(db ?? getDb(), "PAR-47", today);
  if (frequency !== "quarterly" || month % 3 !== 0) return { reminded: 0 };
  const quarter = quarterOf(today);
  return withTx(
    async (tx) => {
      const tenants = await tx.selectDistinct({ tenantId: users.tenantId }).from(users);
      let reminded = 0;
      for (const { tenantId } of tenants) {
        const done = await tx
          .select({ id: accessReviews.id })
          .from(accessReviews)
          .where(and(eq(accessReviews.tenantId, tenantId), eq(accessReviews.quarter, quarter), eq(accessReviews.status, "reviewed")))
          .limit(1);
        if (done[0]) continue;
        const r = await notify(tx, {
          event: "access_review.due",
          tenantId,
          title: `Tinjauan hak akses ${quarter} belum dilakukan`,
          body: `Tinjau daftar pengguna, peran, lingkup, dan login terakhir sebelum ${formatTanggal(quarterRange(quarter).end)} (PAR-47).`,
          objectType: "access_review",
          objectId: quarter,
          groupKey: `access_review.due:${quarter}`,
          link: "/akses/tinjauan",
          now,
        });
        if (r.created.length) reminded++;
      }
      return { reminded };
    },
    { db },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Ringkasan perubahan akses harian (KP-7)
// ---------------------------------------------------------------------------------------------------------------------

const ACCESS_OBJECTS = ["user", "user_role", "user_scope", "device", "access_review", "anonymization_request"] as const;

export type AccessChangeSummary = { date: string; total: number; byKind: Record<string, number>; lines: string[] };

/** Rekap perubahan akses tanggal bisnis `date` (dari jejak audit). */
export async function accessChangesOn(tx: Tx, tenantId: string, date: string): Promise<AccessChangeSummary> {
  const { start, end } = businessDateToUtcRange(date);
  return accessChangesBetween(tx, tenantId, start, end, date);
}

/** Perubahan akses (jejak audit objek akses) pada rentang waktu [start, end). */
export async function accessChangesBetween(tx: Tx, tenantId: string, start: Date, end: Date, date: string = toBusinessDate(end)): Promise<AccessChangeSummary> {
  const rows = await tx
    .select({ objectType: auditLogs.objectType, action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), inArray(auditLogs.objectType, [...ACCESS_OBJECTS]), gte(auditLogs.serverTime, start), lt(auditLogs.serverTime, end)));
  const byKind: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.objectType}:${r.action}`;
    byKind[key] = (byKind[key] ?? 0) + 1;
  }
  const names: Record<string, string> = {
    "user:create": "akun baru diajukan",
    "user:activate": "akun diaktifkan",
    "user:deactivate": "akun dinonaktifkan",
    "user:update": "kredensial/akun diubah",
    "user_role:submit": "permintaan peran",
    "user_role:activate": "peran diaktifkan",
    "user_role:revoke": "peran dicabut",
    "user_scope:submit": "permintaan lingkup",
    "user_scope:activate": "lingkup diaktifkan",
    "user_scope:revoke": "lingkup dikurangi",
    "device:create": "perangkat didaftarkan",
    "device:lock": "perangkat diblokir",
  };
  const lines = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}× ${names[k] ?? k.replace(":", " ")}`);
  return { date, total: rows.length, byKind, lines };
}

/**
 * Job harian (22.15 WIB, sebelum ringkasan e-mail PAR-55): notifikasi ringkasan perubahan akses ke pemilik. US-M10-01
 * KP-7 "SEMUA perubahan": jendela ringkasan = sejak akhir jendela ringkasan terakhir (jejak `access_summary`) sampai
 * sekarang — perubahan 22.15–24.00 masuk ringkasan berikutnya, tidak hilang.
 */
export async function dailyAccessSummary(now: Date = new Date(), db?: Db): Promise<{ tenants: number; notified: number }> {
  const date = toBusinessDate(now);
  return withTx(
    async (tx) => {
      const tenants = await tx.selectDistinct({ tenantId: users.tenantId }).from(users);
      let notified = 0;
      for (const { tenantId } of tenants) {
        const [last] = await tx
          .select({ after: auditLogs.after, serverTime: auditLogs.serverTime })
          .from(auditLogs)
          .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.objectType, "access_summary")))
          .orderBy(desc(auditLogs.serverTime))
          .limit(1);
        const lastEnd = last ? new Date(String((last.after as { windowEnd?: string } | null)?.windowEnd ?? last.serverTime.toISOString())) : null;
        // Tanpa ringkasan sebelumnya: mulai awal hari kemarin (menutup jendela yang mungkin terlewat).
        const start = lastEnd && lastEnd < now ? lastEnd : businessDateToUtcRange(addDays(date, -1)).start;
        const summary = await accessChangesBetween(tx, tenantId, start, now, date);
        if (summary.total === 0) continue;
        const fromDate = toBusinessDate(start);
        await notify(tx, {
          event: "access.daily_summary",
          tenantId,
          title: `Perubahan akses sejak ringkasan terakhir: ${summary.total}`,
          body: summary.lines.slice(0, 12).join("; "),
          objectType: "access_summary",
          objectId: date,
          groupKey: `access.daily_summary:${date}`,
          link: `/audit?dari=${fromDate}&sampai=${date}`,
          now,
        });
        await auditRecord(tx, {
          ctx: systemContext({ tenantId, now }),
          objectType: "access_summary",
          objectId: date,
          action: "create",
          after: { total: summary.total, byKind: summary.byKind, windowStart: start.toISOString(), windowEnd: now.toISOString() },
          rule: "US-M10-01 KP-7",
        });
        notified++;
      }
      return { tenants: tenants.length, notified };
    },
    { db },
  );
}

/** Tanggal bisnis kemarin (utilitas tampilan). */
export function yesterday(date: string): string {
  return addDays(date, -1);
}
