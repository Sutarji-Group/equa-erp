/**
 * Alur persetujuan tunggal (US-M10-04, PRD 6.2a, FR-M10-03/04).
 *
 * - `submit(ctx, { type, objectId, amount, reason, payload, deadlineAt? })` — pemohon harus memegang salah satu
 *   `requesterRoles`; satu permintaan terbuka per (jenis, objek); nomor `A-YY-NNNNNN`; tenggat dihitung dari registri;
 *   audit + notifikasi penyetuju.
 * - `decide(ctx, id, "approve" | "reject", reason?)` — penyetuju = `approverRole` (atau delegasi aktif bila flag
 *   `approvals.delegation`); PEMOHON TIDAK PERNAH DAPAT MENYETUJUI PERMINTAANNYA SENDIRI walau pemilik; alasan wajib
 *   saat menolak; handler modul `onApproved/onRejected` mengubah objek sumber di transaksi yang sama; audit (permintaan
 *   + objek) + event `approval.decided` + notifikasi pemohon.
 * - `cancel(ctx, id, reason)` — hanya pemohon, selama masih Diajukan.
 * - `listInbox(ctx)` — kotak persetujuan (lewat tenggat di atas). `expireDue(now)` — job 5 menit.
 * - `registerApprovalHandler(type, { onApproved, onRejected, onExpired, onCancelled, onOverdue })` — dipanggil modul
 *   dari `registerApprovals()`.
 * - Delegasi (PTB-32): `createDelegation` / `revokeDelegation` — hanya bila flag `approvals.delegation` aktif.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

import { approvalRequests, delegations, userRoles, users } from "@/db/schema";
import { label, type ApprovalType, type RoleCode } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addBusinessDays, isBusinessDate, toBusinessDate, toWibParts, wibToUtc } from "@/lib/time";

import { record as auditRecord } from "../audit";
import { ensureBootstrapped } from "../bootstrap";
import { ctxBusinessDate, isSystem, systemContext, type ActorContext } from "../context";
import { getDb, isTransaction, withTx, type Tx } from "../db";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, parseInput, ValidationError } from "../errors";
import { emit } from "../events";
import { isEnabled } from "../flags";
import { markActionedForObject, notify } from "../notifications/service";
import { nextNumber } from "../numbering";
import { get as getParam } from "../params-read";
import { authorize, recordDenial, runService } from "../rbac/authorize";
import * as sod from "../rbac/sod";
import { APPROVAL_TYPES, getApprovalType, type ApprovalTypeDef, type DeadlineRule } from "./registry";

export type ApprovalRow = typeof approvalRequests.$inferSelect;
export type ApprovalDecision = "approved" | "rejected" | "expired" | "cancelled";

export type ApprovalHandlerArgs = {
  tx: Tx;
  request: ApprovalRow;
  /** Pelaku keputusan (sistem untuk lewat tenggat). */
  ctx: ActorContext;
  decision: ApprovalDecision | "overdue";
  reason: string | null;
};

/** Handler boleh mengembalikan ringkasan efek (disimpan di `approval_requests.outcome`). */
export type ApprovalHandler = (args: ApprovalHandlerArgs) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export type ApprovalHandlers = {
  onApproved?: ApprovalHandler;
  onRejected?: ApprovalHandler;
  onExpired?: ApprovalHandler;
  onCancelled?: ApprovalHandler;
  onOverdue?: ApprovalHandler;
};

const handlerRegistry = new Map<string, ApprovalHandlers>();

/** Daftarkan handler jenis persetujuan milik modul (menggantikan pendaftaran sebelumnya untuk jenis yang sama). */
export function registerApprovalHandler(type: ApprovalType, handlers: ApprovalHandlers): () => void {
  if (!getApprovalType(type)) throw new Error(`Jenis persetujuan tidak dikenal: ${type}. Tambahkan di approvals/registry.ts.`);
  handlerRegistry.set(type, handlers);
  return () => {
    if (handlerRegistry.get(type) === handlers) handlerRegistry.delete(type);
  };
}

export function getApprovalHandlers(type: string): ApprovalHandlers | undefined {
  return handlerRegistry.get(type);
}

function requireDef(type: string): ApprovalTypeDef {
  const def = getApprovalType(type);
  if (!def) throw ValidationError.field("type", `Jenis persetujuan tidak dikenal: ${type}.`);
  return def;
}

/** Hitung tenggat dari aturan registri. */
export async function computeDeadline(
  tx: Tx,
  rule: DeadlineRule,
  now: Date,
  input: { deadlineAt?: Date | null; businessDate?: string | null } = {},
): Promise<Date | null> {
  const today = toBusinessDate(now);
  switch (rule.kind) {
    case "none":
      return input.deadlineAt ?? null;
    case "hours":
      return new Date(now.getTime() + rule.hours * 3_600_000);
    case "days":
      return new Date(now.getTime() + rule.days * 86_400_000);
    case "business_days":
      return wibToUtc(addBusinessDays(today, rule.days), "23:59");
    case "param_day_of_next_month": {
      // BR-32: tenggat "tanggal N bulan berikutnya" dihitung dari PERIODE yang diajukan (kirim tanggal terakhir periode
      // sebagai `businessDate`), bukan dari tanggal pengajuan — pengajuan 3 Okt untuk periode September → 10 Okt.
      if (!input.businessDate || !isBusinessDate(input.businessDate)) {
        throw new DomainError(
          "DEADLINE_REQUIRED",
          "Tanggal periode wajib dikirim (businessDate = tanggal terakhir periode) untuk menghitung tenggat tutup buku.",
        );
      }
      const base = input.businessDate;
      const value = (await getParam(tx, rule.param, today)) as Record<string, unknown>;
      const day = Number(value[rule.field]);
      const p = toWibParts(wibToUtc(base));
      const nextMonth = p.month === 12 ? { y: p.year + 1, m: 1 } : { y: p.year, m: p.month + 1 };
      const date = `${nextMonth.y}-${String(nextMonth.m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return wibToUtc(date, "23:59");
    }
    case "explicit":
      if (!input.deadlineAt) {
        throw new DomainError("DEADLINE_REQUIRED", `Tenggat wajib ditentukan untuk jenis ini (${rule.description}).`);
      }
      return input.deadlineAt;
  }
}

const submitSchema = z.object({
  type: z.string().min(1),
  objectType: z.string().min(1).optional(),
  objectId: z.string().min(1, { error: "Objek yang dimintakan persetujuan wajib dirujuk." }),
  amount: z.number().int({ error: "Nilai harus rupiah bulat." }).nullable().optional(),
  reason: z.string().trim().min(3, { error: "Alasan pengajuan wajib diisi (minimal 3 karakter)." }),
  payload: z.record(z.string(), z.unknown()).optional(),
  deadlineAt: z.date().nullable().optional(),
  businessDate: z.string().nullable().optional(),
  requesterRole: z.string().optional(),
});

export type SubmitApprovalInput = {
  type: ApprovalType;
  /** Bawaan: `objectType` registri. */
  objectType?: string;
  objectId: string;
  amount?: number | null;
  reason: string;
  payload?: Record<string, unknown>;
  /** Wajib untuk jenis bertenggat `explicit` (mis. akhir shift, sebelum jadwal terbit). */
  deadlineAt?: Date | null;
  businessDate?: string | null;
  /** Peran yang dipakai mengajukan (bawaan: peran pertama yang cocok). */
  requesterRole?: RoleCode;
};

/** Ajukan permintaan persetujuan. Boleh dipanggil di dalam transaksi modul (`opts.tx`). */
export async function submit(ctx: ActorContext, input: SubmitApprovalInput, opts: { tx?: Tx } = {}): Promise<ApprovalRow> {
  ensureBootstrapped();
  const parsed = parseInput(submitSchema, input, { reason: "Alasan", objectId: "Objek" });
  const def = requireDef(parsed.type);
  if (!ctx.userId || isSystem(ctx)) {
    throw new DomainError("USER_REQUIRED", "Permintaan persetujuan harus diajukan oleh pengguna, bukan sistem.");
  }
  const requesterRole = (parsed.requesterRole as RoleCode | undefined) ?? def.requesterRoles.find((r) => ctx.roles.includes(r));
  if (!requesterRole || !def.requesterRoles.includes(requesterRole) || !ctx.roles.includes(requesterRole)) {
    const error = new ForbiddenError(
      `Peran Anda tidak dapat mengajukan "${def.label}". Pemohon: ${def.requesterRoles.map((r) => label("role", r)).join(", ")}.`,
      { rule: "RBAC", objectType: parsed.objectType ?? def.objectType, objectId: parsed.objectId },
    );
    if (!isTransaction(opts.tx)) await recordDenial(ctx, error);
    throw error;
  }

  return runService(ctx, opts, async (tx) => {
    const objectType = parsed.objectType ?? def.objectType;
    const open = await tx
      .select({ id: approvalRequests.id, number: approvalRequests.number })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.type, def.type),
          eq(approvalRequests.objectType, objectType),
          eq(approvalRequests.objectId, parsed.objectId),
          eq(approvalRequests.status, "submitted"),
        ),
      )
      .limit(1);
    if (open[0]) {
      throw new ConflictError(
        "APPROVAL_ALREADY_OPEN",
        `Sudah ada permintaan ${open[0].number} yang menunggu keputusan untuk objek ini. Tunggu keputusannya atau batalkan dulu.`,
      );
    }

    const deadlineAt = await computeDeadline(tx, def.deadline, ctx.now, {
      deadlineAt: parsed.deadlineAt ?? null,
      businessDate: parsed.businessDate ?? null,
    });
    const number = await nextNumber(tx, "approval", ctxBusinessDate(ctx), { tenantId: ctx.tenantId });
    const [row] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: ctx.tenantId,
        number,
        type: def.type,
        status: "submitted",
        requesterUserId: ctx.userId!,
        requesterRole,
        approverRole: def.approverRole,
        objectType,
        objectId: parsed.objectId,
        amount: parsed.amount ?? null,
        reason: parsed.reason,
        payload: parsed.payload ?? {},
        businessDate: parsed.businessDate && isBusinessDate(parsed.businessDate) ? parsed.businessDate : ctxBusinessDate(ctx),
        deadlineAt,
      })
      .returning();

    await auditRecord(tx, {
      ctx,
      objectType: "approval_request",
      objectId: row!.id,
      action: "submit",
      after: { number, type: def.type, objectType, objectId: parsed.objectId, amount: parsed.amount ?? null, deadlineAt },
      reason: parsed.reason,
    });

    const valueText = parsed.amount != null ? formatRupiah(parsed.amount) : null;
    await notify(tx, {
      event: "approval.requested",
      tenantId: ctx.tenantId,
      recipients: { roles: [def.approverRole] },
      excludeUserIds: [ctx.userId!],
      severity: def.severity,
      title: `Persetujuan diminta: ${def.label}`,
      body: `${number} oleh ${label("role", requesterRole)}${valueText ? ` — ${valueText}` : ""}. Alasan: ${parsed.reason}`,
      objectType: "approval_request",
      objectId: row!.id,
      valueAmount: parsed.amount ?? null,
      deadlineAt,
      link: `/persetujuan?id=${row!.id}`,
      now: ctx.now,
    });
    if (def.notifyAlso) {
      await notify(tx, {
        event: def.notifyAlso.event,
        tenantId: ctx.tenantId,
        recipients: { roles: def.notifyAlso.roles },
        excludeUserIds: [ctx.userId!],
        title: `${def.label} diajukan`,
        body: `${number} oleh ${label("role", requesterRole)}${valueText ? ` — ${valueText}` : ""}. Keputusan oleh ${label("role", def.approverRole)}. Alasan: ${parsed.reason}`,
        objectType: "approval_request",
        objectId: row!.id,
        valueAmount: parsed.amount ?? null,
        link: `/persetujuan?id=${row!.id}`,
        now: ctx.now,
      });
    }
    return row!;
  });
}

async function loadForUpdate(tx: Tx, id: string): Promise<ApprovalRow> {
  const rows = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).for("update").limit(1);
  if (!rows[0]) throw new NotFoundError("Permintaan persetujuan tidak ditemukan.");
  return rows[0];
}

/** Delegasi aktif yang memberi `userId` hak memutuskan jenis `type` pada waktu `now` (PTB-32). */
export async function activeDelegationFor(tx: Tx, userId: string, type: string, tenantId: string, now: Date) {
  if (!(await isEnabled(tx, "approvals.delegation", { tenantId }))) return null;
  const rows = await tx
    .select()
    .from(delegations)
    .where(
      and(
        eq(delegations.tenantId, tenantId),
        eq(delegations.delegateUserId, userId),
        eq(delegations.approvalType, type),
        lte(delegations.validFrom, now),
        gte(delegations.validUntil, now),
        isNull(delegations.revokedAt),
      ),
    )
    .orderBy(desc(delegations.validFrom))
    .limit(1);
  return rows[0] ?? null;
}

async function userHasActiveRole(tx: Tx, userId: string, role: RoleCode): Promise<boolean> {
  const rows = await tx
    .select({ id: userRoles.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, role), eq(userRoles.status, "active"), eq(users.status, "active")))
    .limit(1);
  return rows.length > 0;
}

const decisionReasonSchema = z.string().trim().min(3, { error: "Alasan wajib diisi saat menolak (minimal 3 karakter)." });

/** Putuskan permintaan (setujui/tolak). */
export async function decide(
  ctx: ActorContext,
  id: string,
  decision: "approve" | "reject",
  reason?: string | null,
  opts: { tx?: Tx } = {},
): Promise<ApprovalRow> {
  ensureBootstrapped();
  await authorize(ctx, "m10.approval.decide", { tx: opts.tx, objectType: "approval_request", objectId: id });
  if (decision !== "approve" && decision !== "reject") throw ValidationError.field("decision", "Keputusan tidak valid.");
  const cleanReason = decision === "reject" ? parseInput(decisionReasonSchema, reason ?? "") : reason?.trim() || null;

  return runService(ctx, opts, async (tx) => {
    const request = await loadForUpdate(tx, id);
    const def = requireDef(request.type);
    if (request.tenantId !== ctx.tenantId) throw new NotFoundError("Permintaan persetujuan tidak ditemukan.");
    if (request.status !== "submitted") {
      throw new ConflictError(
        "APPROVAL_NOT_OPEN",
        `Permintaan ${request.number} sudah ${label("approval_status", request.status).toLowerCase()}; tidak dapat diputuskan lagi.`,
      );
    }
    // FR-M10-03: pemohon tidak pernah dapat menyetujui permintaannya sendiri — walau memegang peran penyetuju.
    sod.assertNotSelf(request.requesterUserId, ctx.userId, "permintaan persetujuan", {
      objectType: "approval_request",
      objectId: request.id,
    });
    if (def.onExpire === "expire" && request.deadlineAt && request.deadlineAt <= ctx.now) {
      throw new ConflictError("APPROVAL_EXPIRED", `Permintaan ${request.number} sudah lewat tenggat: ${def.expireNote}.`);
    }

    let delegationId: string | null = null;
    if (!ctx.roles.includes(def.approverRole)) {
      const delegation = ctx.userId ? await activeDelegationFor(tx, ctx.userId, def.type, ctx.tenantId, ctx.now) : null;
      if (!delegation || !(await userHasActiveRole(tx, delegation.delegatorUserId, def.approverRole))) {
        throw new ForbiddenError(
          `Jenis "${def.label}" hanya dapat diputuskan oleh ${label("role", def.approverRole)} (Bab 6.2a).`,
          { permission: "m10.approval.decide", rule: "RBAC", objectType: "approval_request", objectId: request.id },
        );
      }
      delegationId = delegation.id;
    }

    const status = decision === "approve" ? "approved" : "rejected";
    const handlers = handlerRegistry.get(def.type);
    const handler = decision === "approve" ? handlers?.onApproved : handlers?.onRejected;

    const [updated] = await tx
      .update(approvalRequests)
      .set({ status, decidedBy: ctx.userId, decidedAt: ctx.now, decisionReason: cleanReason, delegationId })
      .where(eq(approvalRequests.id, id))
      .returning();
    const outcome = handler ? await handler({ tx, request: updated!, ctx, decision: status, reason: cleanReason }) : undefined;
    const [final] = outcome
      ? await tx.update(approvalRequests).set({ outcome }).where(eq(approvalRequests.id, id)).returning()
      : [updated!];

    await auditRecord(tx, {
      ctx,
      objectType: "approval_request",
      objectId: request.id,
      action: decision === "approve" ? "approve" : "reject",
      before: { status: "submitted" },
      after: { status, delegationId, outcome: outcome ?? null },
      reason: cleanReason,
    });
    await auditRecord(tx, {
      ctx,
      objectType: request.objectType,
      objectId: request.objectId,
      action: decision === "approve" ? "approve" : "reject",
      after: { approval: request.number, type: def.type },
      reason: cleanReason,
      rule: "6.2a",
    });
    await emit(
      tx,
      "approval.decided",
      {
        approvalId: request.id,
        number: request.number,
        type: def.type,
        decision: status,
        objectType: request.objectType,
        objectId: request.objectId,
        amount: request.amount,
        requesterUserId: request.requesterUserId,
        decidedBy: ctx.userId,
        delegationId,
      },
      { ctx, objectType: "approval_request", objectId: request.id },
    );
    await markActionedForObject(tx, { objectType: "approval_request", objectId: request.id, now: ctx.now });
    await notify(tx, {
      event: "approval.decided",
      tenantId: ctx.tenantId,
      recipients: { userIds: [request.requesterUserId] },
      title: `${def.label} ${status === "approved" ? "disetujui" : "ditolak"}`,
      body: `${request.number}${cleanReason ? ` — alasan: ${cleanReason}` : ""}`,
      objectType: request.objectType,
      objectId: request.objectId,
      link: `/persetujuan?id=${request.id}`,
      now: ctx.now,
    });
    if (delegationId) {
      await notify(tx, {
        event: "approval.delegated_decision",
        tenantId: ctx.tenantId,
        recipients: { roles: [def.approverRole] },
        excludeUserIds: ctx.userId ? [ctx.userId] : [],
        title: `Keputusan delegasi: ${def.label} ${status === "approved" ? "disetujui" : "ditolak"}`,
        body: request.number,
        objectType: "approval_request",
        objectId: request.id,
        now: ctx.now,
      });
    }
    return final!;
  });
}

/** Batalkan permintaan (hanya pemohon, selama Diajukan). */
export async function cancel(ctx: ActorContext, id: string, reason: string, opts: { tx?: Tx } = {}): Promise<ApprovalRow> {
  ensureBootstrapped();
  const cleanReason = parseInput(z.string().trim().min(3, { error: "Alasan pembatalan wajib diisi." }), reason);
  return runService(ctx, opts, async (tx) => {
    const request = await loadForUpdate(tx, id);
    if (request.tenantId !== ctx.tenantId) throw new NotFoundError("Permintaan persetujuan tidak ditemukan.");
    if (!isSystem(ctx) && request.requesterUserId !== ctx.userId) {
      throw new ForbiddenError("Hanya pemohon yang dapat membatalkan permintaan ini.", {
        rule: "RBAC",
        objectType: "approval_request",
        objectId: id,
      });
    }
    if (request.status !== "submitted") {
      throw new ConflictError("APPROVAL_NOT_OPEN", `Permintaan ${request.number} sudah diputuskan; tidak dapat dibatalkan.`);
    }
    const [updated] = await tx
      .update(approvalRequests)
      .set({ status: "cancelled", cancelledAt: ctx.now, cancelReason: cleanReason })
      .where(eq(approvalRequests.id, id))
      .returning();
    const handler = handlerRegistry.get(request.type)?.onCancelled;
    if (handler) await handler({ tx, request: updated!, ctx, decision: "cancelled", reason: cleanReason });
    await auditRecord(tx, {
      ctx,
      objectType: "approval_request",
      objectId: id,
      action: "cancel",
      before: { status: "submitted" },
      after: { status: "cancelled" },
      reason: cleanReason,
    });
    await markActionedForObject(tx, { objectType: "approval_request", objectId: id, now: ctx.now });
    return updated!;
  });
}

export type InboxItem = ApprovalRow & {
  typeLabel: string;
  isOverdue: boolean;
  canDecide: boolean;
  /** Alasan tidak dapat memutuskan (mis. permintaan sendiri). */
  blockedReason: string | null;
  viaDelegation: boolean;
};

/** Kotak persetujuan: permintaan Diajukan yang dapat diputuskan pelaku (lewat tenggat di atas). */
export async function listInbox(ctx: ActorContext, opts: { tx?: Tx; limit?: number } = {}): Promise<InboxItem[]> {
  await authorize(ctx, "m10.approval.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const delegatedTypes: string[] = [];
  if (ctx.userId && (await isEnabled(db, "approvals.delegation", { tenantId: ctx.tenantId }))) {
    const rows = await db
      .select({ type: delegations.approvalType })
      .from(delegations)
      .where(
        and(
          eq(delegations.delegateUserId, ctx.userId),
          lte(delegations.validFrom, ctx.now),
          gte(delegations.validUntil, ctx.now),
          isNull(delegations.revokedAt),
        ),
      );
    delegatedTypes.push(...rows.map((r) => r.type));
  }
  const roleCond = ctx.roles.length ? inArray(approvalRequests.approverRole, ctx.roles) : undefined;
  const delegCond = delegatedTypes.length ? inArray(approvalRequests.type, delegatedTypes) : undefined;
  const who = roleCond && delegCond ? or(roleCond, delegCond) : (roleCond ?? delegCond);
  if (!who) return [];
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.status, "submitted"), who))
    .orderBy(asc(approvalRequests.deadlineAt), asc(approvalRequests.createdAt))
    .limit(Math.min(opts.limit ?? 200, 500));

  const items: InboxItem[] = rows.map((r) => {
    const def = getApprovalType(r.type);
    const isOverdue = !!r.overdueAt || (!!r.deadlineAt && r.deadlineAt <= ctx.now);
    const own = r.requesterUserId === ctx.userId;
    const viaDelegation = !ctx.roles.includes(r.approverRole) && delegatedTypes.includes(r.type);
    return {
      ...r,
      typeLabel: def?.label ?? label("approval_type", r.type),
      isOverdue,
      canDecide: !own,
      blockedReason: own ? "Permintaan Anda sendiri tidak dapat Anda putuskan (FR-M10-03)." : null,
      viaDelegation,
    };
  });
  // Lewat tenggat naik ke puncak (US-M9-04 KP-4); lalu tenggat terdekat; lalu yang terlama.
  return items.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    const da = a.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const dbt = b.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (da !== dbt) return da - dbt;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/** Permintaan yang diajukan pelaku (riwayat pemohon). */
export async function listMine(ctx: ActorContext, opts: { tx?: Tx; limit?: number } = {}): Promise<ApprovalRow[]> {
  if (!ctx.userId) return [];
  const db = opts.tx ?? getDb();
  return db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.requesterUserId, ctx.userId)))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
}

/** Satu permintaan. */
export async function getApproval(tx: Tx, id: string): Promise<ApprovalRow | null> {
  const rows = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Semua permintaan untuk satu objek (riwayat di halaman objek). */
export async function listForObject(tx: Tx, objectType: string, objectId: string): Promise<ApprovalRow[]> {
  return tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.objectType, objectType), eq(approvalRequests.objectId, objectId)))
    .orderBy(desc(approvalRequests.createdAt));
}

export type ExpireResult = { expired: number; escalated: number; errors: { id: string; message: string }[] };

/**
 * Proses permintaan yang melewati tenggat (job `core.approvals.expire_due`, tiap 5 menit): jenis `expire` → Lewat
 * tenggat + handler `onExpired`; jenis `escalate` → penanda lewat tenggat + pengingat ke penyetuju (sekali).
 */
export async function expireDue(now: Date = new Date(), opts: { db?: Tx } = {}): Promise<ExpireResult> {
  ensureBootstrapped();
  const db = opts.db ?? getDb();
  // Hanya yang masih perlu diproses: jenis ber-perilaku lewat tenggat (bukan `none`) dan belum ditandai terlambat
  // (escalate ditandai sekali) — permintaan escalate lama yang menumpuk tidak menutup antrean jenis `expire`.
  const actionable = APPROVAL_TYPES.filter((d) => d.onExpire !== "none").map((d) => d.type);
  const due = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, "submitted"),
        lte(approvalRequests.deadlineAt, now),
        isNull(approvalRequests.overdueAt),
        inArray(approvalRequests.type, actionable),
      ),
    )
    .orderBy(asc(approvalRequests.deadlineAt))
    .limit(500);
  const result: ExpireResult = { expired: 0, escalated: 0, errors: [] };
  for (const { id } of due) {
    try {
      const outcome = await withTx(async (tx) => processExpiry(tx, id, now));
      if (outcome === "expired") result.expired++;
      if (outcome === "escalated") result.escalated++;
    } catch (error) {
      result.errors.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function processExpiry(tx: Tx, id: string, now: Date): Promise<"expired" | "escalated" | "skipped"> {
  const request = await loadForUpdate(tx, id);
  if (request.status !== "submitted" || !request.deadlineAt || request.deadlineAt > now) return "skipped";
  const def = getApprovalType(request.type);
  if (!def || def.onExpire === "none") return "skipped";
  const ctx = systemContext({ tenantId: request.tenantId, now });
  const handlers = handlerRegistry.get(request.type);

  if (def.onExpire === "expire") {
    const [updated] = await tx
      .update(approvalRequests)
      .set({ status: "expired", expiredAt: now })
      .where(eq(approvalRequests.id, id))
      .returning();
    const outcome = handlers?.onExpired ? await handlers.onExpired({ tx, request: updated!, ctx, decision: "expired", reason: def.expireNote }) : undefined;
    if (outcome) await tx.update(approvalRequests).set({ outcome }).where(eq(approvalRequests.id, id));
    await auditRecord(tx, {
      ctx,
      objectType: "approval_request",
      objectId: id,
      action: "expire",
      before: { status: "submitted" },
      after: { status: "expired", outcome: outcome ?? null },
      reason: def.expireNote,
      rule: "6.2a",
    });
    await emit(
      tx,
      "approval.decided",
      {
        approvalId: id,
        number: request.number,
        type: request.type,
        decision: "expired",
        objectType: request.objectType,
        objectId: request.objectId,
        amount: request.amount,
        requesterUserId: request.requesterUserId,
        decidedBy: null,
        delegationId: null,
      },
      { ctx, objectType: "approval_request", objectId: id },
    );
    await markActionedForObject(tx, { objectType: "approval_request", objectId: id, now });
    await notify(tx, {
      event: "approval.decided",
      tenantId: request.tenantId,
      recipients: { userIds: [request.requesterUserId] },
      title: `${def.label} lewat tenggat`,
      body: `${request.number} — ${def.expireNote}.`,
      objectType: request.objectType,
      objectId: request.objectId,
      link: `/persetujuan?id=${id}`,
      now,
    });
    return "expired";
  }

  // escalate: tetap terbuka, tandai sekali + pengingat.
  if (request.overdueAt) return "skipped";
  const [updated] = await tx.update(approvalRequests).set({ overdueAt: now }).where(eq(approvalRequests.id, id)).returning();
  if (handlers?.onOverdue) await handlers.onOverdue({ tx, request: updated!, ctx, decision: "overdue", reason: def.expireNote });
  await auditRecord(tx, {
    ctx,
    objectType: "approval_request",
    objectId: id,
    action: "overdue",
    after: { overdueAt: now },
    reason: def.expireNote,
    rule: "6.2a",
  });
  await notify(tx, {
    event: "approval.overdue",
    tenantId: request.tenantId,
    recipients: { roles: [def.approverRole] },
    excludeUserIds: [request.requesterUserId],
    title: `Lewat tenggat: ${def.label}`,
    body: `${request.number} belum diputuskan. ${def.expireNote}.`,
    objectType: "approval_request",
    objectId: id,
    valueAmount: request.amount,
    link: `/persetujuan?id=${id}`,
    now,
  });
  return "escalated";
}

// ---------------------------------------------------------------------------------------------------------------------
// Delegasi (PTB-32 — dibangun, aktif hanya bila flag approvals.delegation)
// ---------------------------------------------------------------------------------------------------------------------

const delegationSchema = z.object({
  delegateUserId: z.uuid({ error: "Pilih pengguna penerima delegasi." }),
  approvalType: z.string().min(1),
  validFrom: z.date(),
  validUntil: z.date(),
  reason: z.string().trim().min(5, { error: "Alasan delegasi wajib diisi (minimal 5 karakter)." }),
});

export type CreateDelegationInput = z.input<typeof delegationSchema>;

/** Buat delegasi per jenis, berbatas waktu, tidak kepada pemohon/peran bertentangan (US-M10-04 KP-5). */
export async function createDelegation(ctx: ActorContext, input: CreateDelegationInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.delegation.manage", { tx: opts.tx });
  const parsed = parseInput(delegationSchema, input, { delegateUserId: "Penerima", reason: "Alasan" });
  const def = requireDef(parsed.approvalType);
  if (parsed.validUntil <= parsed.validFrom) throw ValidationError.field("validUntil", "Masa berlaku harus berakhir setelah mulai.");
  if (parsed.delegateUserId === ctx.userId) throw ValidationError.field("delegateUserId", "Tidak dapat mendelegasikan kepada diri sendiri.");

  return runService(ctx, opts, async (tx) => {
    if (!(await isEnabled(tx, "approvals.delegation", { tenantId: ctx.tenantId }))) {
      throw new DomainError("DELEGATION_DISABLED", "Pendelegasian persetujuan tidak aktif (PTB-32). Aktifkan fitur dulu bila diputuskan pemilik.");
    }
    const conflicting = await tx
      .select({ role: userRoles.role })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.userId, parsed.delegateUserId), eq(userRoles.status, "active"), eq(users.status, "active")));
    if (conflicting.length === 0) throw ValidationError.field("delegateUserId", "Penerima delegasi harus pengguna aktif.");
    const clash = conflicting.map((r) => r.role).filter((r) => def.requesterRoles.includes(r));
    if (clash.length) {
      throw new ForbiddenError(
        `Delegasi "${def.label}" tidak dapat diberikan kepada ${clash.map((r) => label("role", r)).join(", ")} karena peran itu mengajukan jenis ini (US-M10-04 KP-5).`,
        { rule: "SOD-01", objectType: "delegation" },
      );
    }
    const [row] = await tx
      .insert(delegations)
      .values({
        tenantId: ctx.tenantId,
        delegatorUserId: ctx.userId!,
        delegateUserId: parsed.delegateUserId,
        approvalType: def.type,
        validFrom: parsed.validFrom,
        validUntil: parsed.validUntil,
        reason: parsed.reason,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "delegation", objectId: row!.id, action: "create", after: row, reason: parsed.reason });
    return row!;
  });
}

/** Cabut delegasi seketika. */
export async function revokeDelegation(ctx: ActorContext, id: string, reason: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.delegation.manage", { tx: opts.tx });
  return runService(ctx, opts, async (tx) => {
    const [row] = await tx
      .update(delegations)
      .set({ revokedAt: ctx.now, revokedBy: ctx.userId })
      .where(and(eq(delegations.id, id), eq(delegations.tenantId, ctx.tenantId), isNull(delegations.revokedAt)))
      .returning();
    if (!row) throw new NotFoundError("Delegasi tidak ditemukan atau sudah dicabut.");
    await auditRecord(tx, { ctx, objectType: "delegation", objectId: id, action: "revoke", reason });
    return row;
  });
}

