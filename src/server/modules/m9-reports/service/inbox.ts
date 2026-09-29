/**
 * M9 — Kotak masuk pengecualian pemilik (US-M9-04 KP-2/KP-4; FR-M9-04, PTB-05, Bab 6.2/6.3).
 *
 * "Perlu tindakan" dikelompokkan per jenis: persetujuan menunggu (6.2a), selisih setoran ≥ ambang (M4), rit gagal yang
 * belum dijadwalkan ulang (M2/M3), anomali GPS menunggu tinjauan (M12), susut air (M8). "Info": notifikasi pengguna
 * lainnya (Baru/Dibaca). Setiap butir berasal dari data modulnya (hilang saat diputuskan di modul mana pun).
 * Tindakan langsung: setujui / tolak / minta keterangan / tandai selesai — memanggil layanan modul pemilik objek.
 * Lewat tenggat naik ke puncak + penanda; selisih lewat 24 jam dihitung KPI-03.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { customers, discrepancies, fleetEvents, notifications, orders, trips, trucks, waterBalances, waterSources } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import * as notificationsCore from "@/server/core/notifications";
import { notify } from "@/server/core/notifications";
import { authorize, can, runService } from "@/server/core/rbac";
import * as m4 from "@/server/modules/m4-cash";
import * as m8 from "@/server/modules/m8-production";
import * as m12 from "@/server/modules/m12-fleet";

import { discrepanciesAwaitingOwner, discrepancyFollowUpHours } from "../metrics";
import { inboxActionSchema } from "../schemas";
import { reportRules } from "./h0";

export type InboxKind = "approval" | "discrepancy" | "failed_trip" | "gps" | "water_loss" | "info";
export type InboxAction = "approve" | "reject" | "request_explanation" | "done";

export type InboxItem = {
  key: string;
  kind: InboxKind;
  id: string;
  title: string;
  body: string | null;
  valueText: string | null;
  createdAt: string;
  deadlineAt: string | null;
  overdue: boolean;
  link: string | null;
  actions: InboxAction[];
  approveLabel?: string;
  rejectLabel?: string;
  status?: string;
};

export type InboxGroup = { kind: InboxKind; label: string; items: InboxItem[]; overdue: number };

export type OwnerInbox = {
  action: InboxGroup[];
  info: InboxItem[];
  actionCount: number;
  overdueCount: number;
  kpi03: { overdue: number; followUpHours: number };
};

const ACTION_EVENTS_HANDLED = new Set([
  "approval.requested",
  "approval.overdue",
  "discrepancy.over_threshold",
  "trip.failed",
  "fleet.off_schedule",
  "fleet.unknown_stop",
  "trip.location_deviation",
  "fleet.location_inconsistent",
  "water.loss_over_threshold",
  "water.loss_explained",
]);

const byDeadline = (a: InboxItem, b: InboxItem) => {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const da = a.deadlineAt ? Date.parse(a.deadlineAt) : Number.POSITIVE_INFINITY;
  const db = b.deadlineAt ? Date.parse(b.deadlineAt) : Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
};

/** Kotak masuk pemilik/Admin Keuangan. */
export async function getInbox(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<OwnerInbox> {
  await authorize(ctx, "m9.inbox.read", { tx: opts.tx });
  const db = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await reportRules(db, today, ctx.tenantId);
  const since = addDays(today, -rules.inbox_lookback_days);
  const groups: InboxGroup[] = [];

  // 1) Persetujuan menunggu (selain selisih setoran — tampil di kelompok selisih).
  if (can(ctx, "m10.approval.read")) {
    const list = await approvals.listInbox(ctx, { tx: opts.tx });
    const canDecide = can(ctx, "m10.approval.decide");
    const items: InboxItem[] = list
      .filter((a) => a.type !== "cash_discrepancy")
      .map((a) => ({
        key: `approval:${a.id}`,
        kind: "approval" as const,
        id: a.id,
        title: `${a.typeLabel} — ${a.number}`,
        body: a.reason,
        valueText: a.amount != null ? formatRupiah(a.amount) : null,
        createdAt: a.createdAt.toISOString(),
        deadlineAt: a.deadlineAt?.toISOString() ?? null,
        overdue: a.isOverdue,
        link: `/persetujuan?id=${a.id}`,
        actions: a.canDecide && canDecide ? (["approve", "reject", "request_explanation"] as InboxAction[]) : [],
        status: a.canDecide ? undefined : (a.blockedReason ?? undefined),
      }))
      .sort(byDeadline);
    groups.push({ kind: "approval", label: label("inbox_group", "approval"), items, overdue: items.filter((i) => i.overdue).length });
  }

  // 2) Selisih setoran ≥ ambang menunggu keputusan pemilik (KPI-03: lewat 24 jam).
  const followUpHours = await discrepancyFollowUpHours(db, ctx.tenantId, today);
  const kpi03 = await m4.kpi03(db, ctx.tenantId, { from: addDays(today, -60), to: today, now: ctx.now });
  if (can(ctx, "m4.discrepancy.read")) {
    const discs = await discrepanciesAwaitingOwner(db, ctx.tenantId, ctx.now);
    const canDecide = can(ctx, "m4.discrepancy.decide");
    const items: InboxItem[] = discs
      .map((d) => ({
        key: `discrepancy:${d.id}`,
        kind: "discrepancy" as const,
        id: d.id,
        title: `Selisih ${d.sourceLabel}${d.personName ? ` — ${d.personName}` : ""} (${formatTanggal(d.businessDate)})`,
        body: d.explanation ? `Penjelasan: ${d.explanation}` : "Belum ada penjelasan Admin Keuangan.",
        valueText: formatRupiah(d.amount, { signed: true }),
        createdAt: d.createdAt,
        deadlineAt: new Date(Date.parse(d.createdAt) + followUpHours * 3_600_000).toISOString(),
        overdue: d.overdue,
        link: `/kas/selisih?id=${d.id}`,
        actions: canDecide ? (["approve", "reject", "request_explanation"] as InboxAction[]) : (["request_explanation"] as InboxAction[]),
        approveLabel: "Setujui",
        rejectLabel: "Tolak",
      }))
      .sort(byDeadline);
    groups.push({ kind: "discrepancy", label: label("inbox_group", "discrepancy"), items, overdue: items.filter((i) => i.overdue).length });
  }

  // 3) Rit gagal yang pesanannya belum dijadwalkan ulang / perlu konfirmasi ulang.
  const failed = await db
    .select({ t: trips, customerName: customers.name, truckCode: trucks.code, needsReschedule: orders.needsReschedule, reconfirm: orders.reconfirmationRequired, orderId: orders.id })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.status, "failed"), gte(trips.completionBusinessDate, since), or(eq(orders.needsReschedule, true), eq(orders.reconfirmationRequired, true))))
    .orderBy(desc(trips.failedAt));
  groups.push({
    kind: "failed_trip",
    label: label("inbox_group", "failed_trip"),
    items: failed.map(({ t, customerName, truckCode, reconfirm, orderId }) => ({
      key: `failed_trip:${t.id}`,
      kind: "failed_trip" as const,
      id: t.id,
      title: `Rit ${t.number} gagal — ${customerName}`,
      body: `${t.failReason ? label("trip_fail_reason", t.failReason) : "Tanpa alasan"}${t.failNote ? `: ${t.failNote}` : ""}${truckCode ? ` · truk ${truckCode}` : ""}${reconfirm ? " · perlu konfirmasi ulang (BR-24)" : " · perlu jadwal ulang"}`,
      valueText: formatRupiah(t.price),
      createdAt: (t.failedAt ?? t.updatedAt).toISOString(),
      deadlineAt: null,
      overdue: false,
      link: `/pesanan/${orderId}`,
      actions: ["request_explanation"] as InboxAction[],
    })),
    overdue: 0,
  });

  // 4) Anomali GPS menunggu tinjauan pemilik (M12).
  if (can(ctx, "m12.fleet_event.read")) {
    const events = await m12.listFleetEvents(ctx, { view: "review", from: since, to: today }, { tx: opts.tx });
    const canReview = can(ctx, "m12.fleet_event.review");
    groups.push({
      kind: "gps",
      label: label("inbox_group", "gps"),
      items: events.map((e) => ({
        key: `gps:${e.id}`,
        kind: "gps" as const,
        id: e.id,
        title: `${e.kindLabel}${e.truckCode ? ` — truk ${e.truckCode}` : ""} (${formatTanggal(e.businessDate)})`,
        body: e.explanation ? `Keterangan sopir: ${e.explanation}` : "Belum ada keterangan sopir.",
        valueText: null,
        createdAt: e.startedAt.toISOString(),
        deadlineAt: null,
        overdue: false,
        link: `/armada/kejadian/${e.id}`,
        actions: canReview ? (["approve", "request_explanation"] as InboxAction[]) : [],
        approveLabel: "Terima alasan",
      })),
      overdue: 0,
    });
  }

  // 5) Susut air di atas ambang / investigasi / susut negatif (M8).
  const balances = await db
    .select({ b: waterBalances, code: waterSources.code, name: waterSources.name })
    .from(waterBalances)
    .innerJoin(waterSources, eq(waterSources.id, waterBalances.waterSourceId))
    .where(and(eq(waterBalances.tenantId, ctx.tenantId), inArray(waterBalances.status, ["over_threshold", "investigating", "negative_anomaly"])))
    .orderBy(desc(waterBalances.businessDate))
    .limit(50);
  const canAcceptLoss = can(ctx, "m8.loss_investigation.accept");
  groups.push({
    kind: "water_loss",
    label: label("inbox_group", "water_loss"),
    items: balances.map(({ b, code, name }) => ({
      key: `water_loss:${b.id}`,
      kind: "water_loss" as const,
      id: b.id,
      title: `${label("water_balance_status", b.status)} — ${code} ${name} (${formatTanggal(b.businessDate)})`,
      body:
        b.status === "investigating"
          ? `Penjelasan operator: ${b.investigationReason ? label("loss_reason", b.investigationReason) : ""}${b.investigationNote ? ` — ${b.investigationNote}` : ""}`
          : `Susut ${b.lossPct ?? "—"}% (${(b.lossL ?? 0).toLocaleString("id-ID")} L)`,
      valueText: b.lossPct != null ? `${b.lossPct}%` : null,
      createdAt: (b.computedAt ?? b.updatedAt).toISOString(),
      deadlineAt: null,
      overdue: false,
      link: `/produksi/neraca-air/rincian?sumber=${b.waterSourceId}&tanggal=${b.businessDate}`,
      actions: b.status === "investigating" && canAcceptLoss ? (["approve", "reject", "request_explanation"] as InboxAction[]) : (["request_explanation"] as InboxAction[]),
      approveLabel: "Terima penjelasan",
      rejectLabel: "Kembalikan",
    })),
    overdue: 0,
  });

  // Info: notifikasi pengguna lainnya (Baru/Dibaca), tidak dihapus — tandai Selesai.
  const notes = await notificationsCore.list(ctx, { status: ["new", "read"], limit: 100, tx: opts.tx });
  const info: InboxItem[] = notes
    .filter((n) => !ACTION_EVENTS_HANDLED.has(n.event))
    .map((n) => ({
      key: `info:${n.id}`,
      kind: "info" as const,
      id: n.id,
      title: n.title,
      body: n.body,
      valueText: n.valueText ?? (n.valueAmount != null ? formatRupiah(n.valueAmount) : null),
      createdAt: n.createdAt.toISOString(),
      deadlineAt: n.deadlineAt?.toISOString() ?? null,
      overdue: !!n.deadlineAt && n.deadlineAt <= ctx.now,
      link: n.link,
      actions: ["done"] as InboxAction[],
      status: label("notification_status", n.status),
    }))
    .sort(byDeadline);

  const actionGroups = groups.filter((g) => g.items.length > 0).sort((a, b) => b.overdue - a.overdue);
  return {
    action: actionGroups,
    info,
    actionCount: actionGroups.reduce((s, g) => s + g.items.length, 0),
    overdueCount: actionGroups.reduce((s, g) => s + g.overdue, 0),
    kpi03: { overdue: kpi03.overdue, followUpHours },
  };
}

/** Kirim permintaan keterangan (notifikasi `inbox.explanation_requested`) + jejak audit objek. */
async function requestExplanation(
  tx: Tx,
  ctx: ActorContext,
  input: { objectType: string; objectId: string; title: string; note: string; link: string | null; recipients: { roles?: ("finance_admin" | "dispatcher" | "production_operator")[]; userIds?: string[]; scope?: { sourceId?: string } } },
) {
  await notify(tx, {
    event: "inbox.explanation_requested",
    tenantId: ctx.tenantId,
    recipients: input.recipients,
    excludeUserIds: ctx.userId ? [ctx.userId] : [],
    title: input.title,
    body: `Pemilik meminta keterangan: ${input.note}`,
    objectType: input.objectType,
    objectId: input.objectId,
    link: input.link,
    now: ctx.now,
  });
  await auditRecord(tx, { ctx, objectType: input.objectType, objectId: input.objectId, action: "request_explanation", reason: input.note, rule: "US-M9-04 KP-2" });
}

/**
 * Tindakan langsung dari kotak masuk: setujui / tolak (alasan wajib) / minta keterangan (catatan wajib) / tandai
 * Selesai (info). Keputusan memakai layanan modul pemilik objek (persetujuan inti, M4, M8, M12) — otorisasi & SoD
 * modul itu berlaku.
 */
export async function actOnInboxItem(ctx: ActorContext, input: unknown): Promise<{ message: string }> {
  await authorize(ctx, "m9.inbox.read");
  const data = parseInput(inboxActionSchema, input, { itemKind: "Jenis", itemId: "Butir", action: "Tindakan", note: "Catatan" });
  // Lencana menu dihitung ulang setelah tindakan (B-58).
  badgeCache.clear();
  const note = data.note ?? null;
  switch (data.itemKind) {
    case "approval": {
      if (data.action === "approve" || data.action === "reject") {
        await approvals.decide(ctx, data.itemId, data.action, note ?? undefined);
        return { message: data.action === "approve" ? "Permintaan disetujui." : "Permintaan ditolak." };
      }
      if (data.action === "request_explanation") {
        await runService(ctx, {}, async (tx) => {
          const req = await approvals.getApproval(tx, data.itemId);
          if (!req || req.tenantId !== ctx.tenantId) throw new NotFoundError("Permintaan persetujuan tidak ditemukan.");
          await requestExplanation(tx, ctx, {
            objectType: "approval_request",
            objectId: req.id,
            title: `Keterangan diminta: ${req.number}`,
            note: note!,
            link: `/persetujuan?id=${req.id}`,
            recipients: { userIds: [req.requesterUserId] },
          });
        });
        return { message: "Permintaan keterangan dikirim ke pemohon." };
      }
      break;
    }
    case "discrepancy": {
      if (data.action === "approve" || data.action === "reject") {
        await m4.decideDiscrepancy(ctx, data.itemId, { decision: data.action, reason: note ?? undefined });
        return { message: data.action === "approve" ? "Selisih disetujui." : "Selisih ditolak — dikembalikan ke Admin Keuangan." };
      }
      if (data.action === "request_explanation") {
        await authorize(ctx, "m4.discrepancy.read");
        await runService(ctx, {}, async (tx) => {
          const [d] = await tx.select().from(discrepancies).where(eq(discrepancies.id, data.itemId)).limit(1);
          if (!d || d.tenantId !== ctx.tenantId) throw new NotFoundError("Selisih tidak ditemukan.");
          await requestExplanation(tx, ctx, {
            objectType: "discrepancy",
            objectId: d.id,
            title: `Keterangan selisih ${formatRupiah(d.amount, { signed: true })} (${formatTanggal(d.businessDate)}) diminta pemilik`,
            note: note!,
            link: `/kas/selisih?id=${d.id}`,
            recipients: { roles: ["finance_admin"] },
          });
        });
        return { message: "Permintaan keterangan dikirim ke Admin Keuangan." };
      }
      break;
    }
    case "failed_trip": {
      if (data.action === "request_explanation") {
        await runService(ctx, {}, async (tx) => {
          const [t] = await tx.select().from(trips).where(eq(trips.id, data.itemId)).limit(1);
          if (!t || t.tenantId !== ctx.tenantId) throw new NotFoundError("Rit tidak ditemukan.");
          await requestExplanation(tx, ctx, {
            objectType: "trip",
            objectId: t.id,
            title: `Keterangan rit gagal ${t.number} diminta pemilik`,
            note: note!,
            link: `/pesanan/${t.orderId}`,
            recipients: { roles: ["dispatcher"] },
          });
        });
        return { message: "Permintaan keterangan dikirim ke Dispatcher." };
      }
      break;
    }
    case "gps": {
      if (data.action === "approve") {
        await m12.reviewFleetEvent(ctx, { fleetEventId: data.itemId, decision: "accepted", note: note ?? "Diterima dari kotak masuk." });
        return { message: "Alasan diterima — kejadian Selesai." };
      }
      if (data.action === "request_explanation") {
        await m12.reviewFleetEvent(ctx, { fleetEventId: data.itemId, decision: "request_explanation", note });
        return { message: "Permintaan keterangan dikirim ke sopir." };
      }
      break;
    }
    case "water_loss": {
      if (data.action === "approve") {
        await m8.acceptLossInvestigation(ctx, { waterBalanceId: data.itemId, note });
        return { message: "Penjelasan susut diterima — neraca Selesai." };
      }
      if (data.action === "reject") {
        await m8.returnLossInvestigation(ctx, { waterBalanceId: data.itemId, note: note! });
        return { message: "Penjelasan dikembalikan ke operator." };
      }
      if (data.action === "request_explanation") {
        await authorize(ctx, "m8.water_balance.read");
        await runService(ctx, {}, async (tx) => {
          const [b] = await tx.select().from(waterBalances).where(eq(waterBalances.id, data.itemId)).limit(1);
          if (!b || b.tenantId !== ctx.tenantId) throw new NotFoundError("Neraca air tidak ditemukan.");
          await requestExplanation(tx, ctx, {
            objectType: "water_balance",
            objectId: b.id,
            title: `Keterangan susut air ${formatTanggal(b.businessDate)} diminta pemilik`,
            note: note!,
            link: `/produksi/neraca-air/rincian?sumber=${b.waterSourceId}&tanggal=${b.businessDate}`,
            recipients: b.status === "negative_anomaly" ? { roles: ["finance_admin"] } : { roles: ["production_operator"], scope: { sourceId: b.waterSourceId } },
          });
        });
        return { message: "Permintaan keterangan dikirim." };
      }
      break;
    }
    case "info": {
      if (data.action === "done") {
        await notificationsCore.markDone(ctx, data.itemId);
        return { message: "Ditandai selesai." };
      }
      break;
    }
  }
  throw new DomainError("INBOX_ACTION", "Tindakan ini tidak tersedia untuk butir tersebut.");
}

/** Jumlah butir "Perlu tindakan" (lencana menu Kotak masuk). */
export async function inboxCount(ctx: ActorContext): Promise<{ count: number; overdue: number }> {
  const box = await getInbox(ctx);
  return { count: box.actionCount, overdue: box.overdueCount };
}

// =====================================================================================================================
// Lencana menu "Kotak masuk" (B-58): hitungan murah di setiap render kerangka kantor
// =====================================================================================================================

/** Umur cache hitungan lencana per pengguna (teknis, bukan aturan bisnis): cukup segar untuk menu, murah untuk DB. */
const BADGE_CACHE_TTL_MS = 30_000;
const BADGE_CACHE_MAX = 500;
const badgeCache = new Map<string, { at: number; value: { count: number; overdue: number } }>();

/** Kosongkan cache lencana (uji / setelah tindakan kotak masuk). */
export function clearInboxBadgeCache(): void {
  badgeCache.clear();
}

/**
 * Hitungan lencana "Kotak masuk" = jumlah butir "Perlu tindakan" `getInbox` (angka sama), tetapi dengan kueri COUNT
 * terindeks per kelompok — tanpa membangun judul/isi butir, tanpa notifikasi info — plus cache singkat per pengguna.
 * `approvalItems` = hasil `approvals.listInbox` yang sudah diambil kerangka kantor (menghindari kueri ganda).
 */
export async function inboxBadgeCount(
  ctx: ActorContext,
  opts: { tx?: Tx; approvalItems?: readonly { type: string; isOverdue: boolean }[]; fresh?: boolean } = {},
): Promise<{ count: number; overdue: number }> {
  await authorize(ctx, "m9.inbox.read", { tx: opts.tx });
  const key = `${ctx.tenantId}:${ctx.userId ?? "-"}:${[...ctx.roles].sort().join(",")}`;
  const hit = badgeCache.get(key);
  if (!opts.fresh && hit && ctx.now.getTime() - hit.at >= 0 && ctx.now.getTime() - hit.at < BADGE_CACHE_TTL_MS) return hit.value;
  const db = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await reportRules(db, today, ctx.tenantId);
  const since = addDays(today, -rules.inbox_lookback_days);
  let count = 0;
  let overdue = 0;

  if (can(ctx, "m10.approval.read")) {
    const items = opts.approvalItems ?? (await approvals.listInbox(ctx, { tx: opts.tx, limit: 500 }));
    for (const a of items) {
      if (a.type === "cash_discrepancy") continue;
      count++;
      if (a.isOverdue) overdue++;
    }
  }
  if (can(ctx, "m4.discrepancy.read")) {
    const hours = await discrepancyFollowUpHours(db, ctx.tenantId, today);
    const cutoff = new Date(ctx.now.getTime() - hours * 3_600_000);
    const [d] = await db
      .select({ n: sql<number>`count(*)::int`, late: sql<number>`count(*) filter (where ${discrepancies.createdAt} < ${cutoff})::int` })
      .from(discrepancies)
      .where(
        and(
          eq(discrepancies.tenantId, ctx.tenantId),
          eq(discrepancies.requiresOwnerDecision, true),
          isNull(discrepancies.decision),
          inArray(discrepancies.status, ["formed", "explained"]),
        ),
      );
    count += Number(d?.n ?? 0);
    overdue += Number(d?.late ?? 0);
  }
  const [f] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trips)
    .innerJoin(orders, eq(orders.id, trips.orderId))
    .where(and(eq(trips.tenantId, ctx.tenantId), eq(trips.status, "failed"), gte(trips.completionBusinessDate, since), or(eq(orders.needsReschedule, true), eq(orders.reconfirmationRequired, true))));
  count += Number(f?.n ?? 0);
  if (can(ctx, "m12.fleet_event.read")) {
    const [g] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fleetEvents)
      .where(
        and(
          eq(fleetEvents.tenantId, ctx.tenantId),
          gte(fleetEvents.businessDate, since),
          lte(fleetEvents.businessDate, today),
          inArray(fleetEvents.kind, [...m12.REVIEW_KINDS]),
          inArray(fleetEvents.status, ["detected", "explained"]),
        ),
      );
    count += Math.min(Number(g?.n ?? 0), 500);
  }
  const [w] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waterBalances)
    .where(and(eq(waterBalances.tenantId, ctx.tenantId), inArray(waterBalances.status, ["over_threshold", "investigating", "negative_anomaly"])));
  count += Math.min(Number(w?.n ?? 0), 50);

  const value = { count, overdue };
  if (badgeCache.size >= BADGE_CACHE_MAX) badgeCache.delete(badgeCache.keys().next().value!);
  badgeCache.set(key, { at: ctx.now.getTime(), value });
  return value;
}

/** Notifikasi terbaru (tidak dipakai kelompok) — untuk uji/diagnostik. */
export async function recentNotifications(tx: Tx, userId: string) {
  return tx.select().from(notifications).where(eq(notifications.recipientUserId, userId)).orderBy(asc(notifications.createdAt));
}
