/**
 * Layanan notifikasi (Bab 6.3, US-M9-04; PTB-05): pusat notifikasi in-app + Web Push + ringkasan e-mail harian.
 *
 * - `notify(tx, { event, recipients: { roles | userIds | scope }, title, body, objectType, objectId, valueAmount,
 *   deadlineAt, link })` — penerima per peran → pengguna AKTIF dengan peran aktif (dan lingkup bila `scope`), atau
 *   `userIds`. Preferensi per jenis: seketika / ringkasan harian / mati (kritis TIDAK dapat dimatikan); jam tenang
 *   (preferensi pengguna, bawaan PAR-56) menahan push non-kritis. Push dikirim SETELAH commit.
 * - `list`, `unreadCount`, `markRead`, `markActioned`, `markDone`, `markAllRead` — status maju saja; TIDAK ADA hapus.
 * - `getPreferences`, `setPreference`, `setQuietHours`.
 */
import "server-only";

import { and, count, desc, eq, gt, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";

import { notificationPreferences, notifications, pushSubscriptions, userRoles, users, userScopes } from "@/db/schema";
import type { NotificationSeverity, RoleCode } from "@/lib/labels";
import { addBusinessDays, isWithinWindow, toBusinessDate, wibToUtc } from "@/lib/time";

import type { ActorContext } from "../context";
import { getDb, onAfterCommit, type Tx } from "../db";
import { DomainError, NotFoundError, ValidationError } from "../errors";
import { get as getParam } from "../params-read";
import { canDisable, getNotificationEvent, NOTIFICATION_EVENTS, type NotificationEventDef } from "./catalog";
import { sendWebPush, type PushPayload, type PushResult, type PushSubscriptionKeys } from "./channels/webpush";

type PushSender = (subscription: PushSubscriptionKeys, payload: PushPayload) => Promise<PushResult>;
let pushSender: PushSender = sendWebPush;

/** Ganti pengirim push (khusus uji). `null` = kembali ke Web Push asli. */
export function setPushSenderForTests(sender: PushSender | null): void {
  pushSender = sender ?? sendWebPush;
}

export type NotificationMode = "immediate" | "daily_digest" | "off";
export type NotificationRow = typeof notifications.$inferSelect;

export type NotifyRecipients = {
  roles?: readonly RoleCode[];
  userIds?: readonly string[];
  /** Batasi penerima peran ke lingkup unit (pengguna berlingkup unit itu atau berlingkup tenant). */
  scope?: { truckId?: string | null; outletId?: string | null; sourceId?: string | null };
};

export type NotifyInput = {
  event: string;
  /** WAJIB (NFR-30): penerima dicari di tenant ini — tanpa bawaan EQUA. */
  tenantId: string;
  /** Bawaan: `defaultRoles` katalog. */
  recipients?: NotifyRecipients;
  excludeUserIds?: readonly string[];
  title: string;
  body?: string | null;
  severity?: NotificationSeverity;
  objectType?: string | null;
  objectId?: string | null;
  valueAmount?: number | null;
  valueText?: string | null;
  /** Bawaan: sekarang + `deadlineHours` katalog. */
  deadlineAt?: Date | null;
  link?: string | null;
  groupKey?: string | null;
  now?: Date;
};

export type NotifyResult = { created: NotificationRow[]; skippedOff: string[]; recipients: string[] };

const QUIET_EVENT_KEY = "*";

function requireEvent(code: string): NotificationEventDef {
  const def = getNotificationEvent(code);
  if (!def) throw new Error(`Kode notifikasi tidak dikenal: ${code}. Tambahkan di notifications/catalog.ts.`);
  return def;
}

/** Pengguna aktif dengan salah satu peran aktif (masa berlaku mencakup hari ini) di tenant. */
async function usersWithRoles(tx: Tx, tenantId: string, roles: readonly RoleCode[], today: string): Promise<string[]> {
  if (roles.length === 0) return [];
  const rows = await tx
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.status, "active"),
        eq(userRoles.status, "active"),
        inArray(userRoles.role, [...roles]),
        or(isNull(userRoles.validFrom), lte(userRoles.validFrom, today)),
        or(isNull(userRoles.validUntil), sql`${userRoles.validUntil} >= ${today}`),
      ),
    );
  return rows.map((r) => r.id);
}

async function filterByScope(
  tx: Tx,
  userIds: string[],
  tenantId: string,
  scope: NonNullable<NotifyRecipients["scope"]>,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const refs: SQL[] = [and(eq(userScopes.scopeType, "tenant"), eq(userScopes.refId, tenantId))!];
  if (scope.truckId) refs.push(and(eq(userScopes.scopeType, "truck"), eq(userScopes.refId, scope.truckId))!);
  if (scope.outletId) refs.push(and(eq(userScopes.scopeType, "outlet"), eq(userScopes.refId, scope.outletId))!);
  if (scope.sourceId) refs.push(and(eq(userScopes.scopeType, "water_source"), eq(userScopes.refId, scope.sourceId))!);
  const rows = await tx
    .selectDistinct({ userId: userScopes.userId })
    .from(userScopes)
    .where(and(inArray(userScopes.userId, userIds), eq(userScopes.status, "active"), or(...refs)));
  const allowed = new Set(rows.map((r) => r.userId));
  return userIds.filter((id) => allowed.has(id));
}

async function activeUsers(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

type PrefInfo = { mode: NotificationMode; quietStart: string | null; quietEnd: string | null };

async function loadPrefs(tx: Tx, userIds: string[], event: string): Promise<Map<string, PrefInfo>> {
  const out = new Map<string, PrefInfo>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(notificationPreferences)
    .where(and(inArray(notificationPreferences.userId, userIds), inArray(notificationPreferences.event, [event, QUIET_EVENT_KEY])));
  for (const id of userIds) out.set(id, { mode: "immediate", quietStart: null, quietEnd: null });
  for (const row of rows) {
    const info = out.get(row.userId)!;
    if (row.event === event) info.mode = row.mode as NotificationMode;
    if (row.event === QUIET_EVENT_KEY) {
      info.quietStart = row.quietStart ? row.quietStart.slice(0, 5) : null;
      info.quietEnd = row.quietEnd ? row.quietEnd.slice(0, 5) : null;
    }
  }
  return out;
}

/** Tenggat bawaan dari katalog (6.3): hari kerja / menit / jam. */
export function catalogDeadline(def: NotificationEventDef, now: Date): Date | null {
  if (def.deadlineRule?.kind === "business_days") return wibToUtc(addBusinessDays(toBusinessDate(now), def.deadlineRule.days), "23:59");
  if (def.deadlineRule?.kind === "minutes") return new Date(now.getTime() + def.deadlineRule.minutes * 60_000);
  return def.deadlineHours ? new Date(now.getTime() + def.deadlineHours * 3_600_000) : null;
}

/** Buat notifikasi untuk penerima; push dikirim setelah commit (kecuali ringkasan harian / jam tenang). */
export async function notify(tx: Tx, input: NotifyInput): Promise<NotifyResult> {
  const def = requireEvent(input.event);
  const now = input.now ?? new Date();
  const today = toBusinessDate(now);
  if (!input.tenantId) throw new Error(`notify(${input.event}): tenantId wajib diisi (NFR-30).`);
  const tenantId = input.tenantId;
  const severity = input.severity ?? def.severity;
  const critical = severity === "critical";

  const recipientsSpec = input.recipients ?? { roles: def.defaultRoles };
  if (def.defaultScope && (recipientsSpec.roles?.length ?? 0) > 0) {
    const key = def.defaultScope === "outlet" ? "outletId" : def.defaultScope === "truck" ? "truckId" : "sourceId";
    if (!recipientsSpec.scope?.[key]) {
      throw new Error(`notify(${input.event}): kode berlingkup ${def.defaultScope} — isi recipients.scope.${key} agar unit lain tidak ikut menerima.`);
    }
  }
  let ids = await usersWithRoles(tx, tenantId, recipientsSpec.roles ?? [], today);
  if (recipientsSpec.scope && (recipientsSpec.scope.truckId || recipientsSpec.scope.outletId || recipientsSpec.scope.sourceId)) {
    ids = await filterByScope(tx, ids, tenantId, recipientsSpec.scope);
  }
  ids = Array.from(new Set([...ids, ...(await activeUsers(tx, recipientsSpec.userIds ?? []))]));
  const exclude = new Set(input.excludeUserIds ?? []);
  ids = ids.filter((id) => !exclude.has(id));
  if (ids.length === 0) return { created: [], skippedOff: [], recipients: [] };

  const prefs = await loadPrefs(tx, ids, input.event);
  const quiet = await getParam(tx, "PAR-56", today);
  const deadlineAt = input.deadlineAt !== undefined ? input.deadlineAt : catalogDeadline(def, now);

  const skippedOff: string[] = [];
  const toPush: string[] = [];
  const values: (typeof notifications.$inferInsert)[] = [];
  for (const userId of ids) {
    const pref = prefs.get(userId)!;
    const mode: NotificationMode = critical ? "immediate" : pref.mode;
    if (mode === "off") {
      skippedOff.push(userId);
      continue;
    }
    values.push({
      tenantId,
      recipientUserId: userId,
      event: input.event,
      severity,
      title: input.title,
      body: input.body ?? null,
      objectType: input.objectType ?? null,
      objectId: input.objectId ?? null,
      valueAmount: input.valueAmount ?? null,
      valueText: input.valueText ?? null,
      deadlineAt,
      link: input.link ?? null,
      groupKey: input.groupKey ?? null,
    });
    const inQuiet = isWithinWindow(pref.quietStart ?? quiet.start, pref.quietEnd ?? quiet.end, now);
    if (mode === "immediate" && (critical || !inQuiet)) toPush.push(userId);
  }
  const created = values.length ? await tx.insert(notifications).values(values).returning() : [];

  const pushIds = created.filter((n) => toPush.includes(n.recipientUserId)).map((n) => n.id);
  if (pushIds.length) onAfterCommit(tx, () => deliverPushes(pushIds));
  return { created, skippedOff, recipients: ids };
}

/** Kirim push untuk notifikasi (setelah commit). Menandai `pushed_at` bila minimal satu langganan menerima. */
export async function deliverPushes(notificationIds: readonly string[], db: Tx = getDb()): Promise<number> {
  if (notificationIds.length === 0) return 0;
  const rows = await db.select().from(notifications).where(inArray(notifications.id, [...notificationIds]));
  let sent = 0;
  for (const n of rows) {
    if (n.pushedAt) continue;
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, n.recipientUserId), isNull(pushSubscriptions.revokedAt)));
    let delivered = false;
    for (const sub of subs) {
      const res = await pushSender(sub, { title: n.title, body: n.body, url: n.link, tag: n.groupKey ?? n.event, severity: n.severity });
      if (res.ok) delivered = true;
      if (res.gone) await db.update(pushSubscriptions).set({ revokedAt: new Date() }).where(eq(pushSubscriptions.id, sub.id));
    }
    if (delivered) {
      await db.update(notifications).set({ pushedAt: new Date() }).where(eq(notifications.id, n.id));
      sent++;
    }
  }
  return sent;
}

/**
 * Cadangan push (job 5 menit): notifikasi 30 menit terakhir yang belum ter-push, penerimanya punya langganan push,
 * dan (kritis ATAU preferensi seketika di luar jam tenang).
 */
export async function deliverPendingPushes(now: Date = new Date(), db: Tx = getDb()): Promise<number> {
  const since = new Date(now.getTime() - 30 * 60_000);
  const until = new Date(now.getTime() - 60_000);
  const rows = await db
    .select({ id: notifications.id, event: notifications.event, severity: notifications.severity, userId: notifications.recipientUserId })
    .from(notifications)
    .innerJoin(pushSubscriptions, and(eq(pushSubscriptions.userId, notifications.recipientUserId), isNull(pushSubscriptions.revokedAt)))
    .where(and(isNull(notifications.pushedAt), eq(notifications.status, "new"), gt(notifications.createdAt, since), lt(notifications.createdAt, until)));
  if (rows.length === 0) return 0;
  const quiet = await getParam(db, "PAR-56", toBusinessDate(now));
  const eligible: string[] = [];
  for (const row of rows) {
    if (row.severity === "critical") {
      eligible.push(row.id);
      continue;
    }
    const pref = (await loadPrefs(db, [row.userId], row.event)).get(row.userId)!;
    if (pref.mode !== "immediate") continue;
    if (isWithinWindow(pref.quietStart ?? quiet.start, pref.quietEnd ?? quiet.end, now)) continue;
    eligible.push(row.id);
  }
  return deliverPushes(Array.from(new Set(eligible)), db);
}

// ---------------------------------------------------------------------------------------------------------------------
// Kotak notifikasi pengguna
// ---------------------------------------------------------------------------------------------------------------------

const STATUS_ORDER = { new: 0, read: 1, actioned: 2, done: 3 } as const;
type NotifStatus = keyof typeof STATUS_ORDER;

function requireUser(ctx: ActorContext): string {
  if (!ctx.userId) throw new DomainError("USER_REQUIRED", "Silakan masuk terlebih dahulu untuk melihat notifikasi.");
  return ctx.userId;
}

export type ListNotificationsOptions = {
  status?: NotifStatus | NotifStatus[];
  severity?: NotificationSeverity;
  limit?: number;
  /** Kursor: notifikasi lebih lama dari waktu ini. */
  before?: Date;
  tx?: Tx;
};

/** Notifikasi milik pengguna (terbaru dulu). */
export async function list(ctx: ActorContext, opts: ListNotificationsOptions = {}): Promise<NotificationRow[]> {
  const userId = requireUser(ctx);
  const db = opts.tx ?? getDb();
  const where: SQL[] = [eq(notifications.recipientUserId, userId)];
  if (opts.status) {
    where.push(Array.isArray(opts.status) ? inArray(notifications.status, opts.status) : eq(notifications.status, opts.status));
  }
  if (opts.severity) where.push(eq(notifications.severity, opts.severity));
  if (opts.before) where.push(lt(notifications.createdAt, opts.before));
  return db
    .select()
    .from(notifications)
    .where(and(...where))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

/** Jumlah notifikasi berstatus Baru. */
export async function unreadCount(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<number> {
  const userId = requireUser(ctx);
  const db = opts.tx ?? getDb();
  const rows = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, userId), eq(notifications.status, "new")));
  return Number(rows[0]?.n ?? 0);
}

async function advance(ctx: ActorContext, id: string, to: NotifStatus, opts: { tx?: Tx } = {}): Promise<NotificationRow> {
  const userId = requireUser(ctx);
  const db = opts.tx ?? getDb();
  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.recipientUserId !== userId) throw new NotFoundError("Notifikasi tidak ditemukan.");
  if (STATUS_ORDER[row.status as NotifStatus] >= STATUS_ORDER[to]) return row;
  const now = ctx.now ?? new Date();
  const patch: Partial<typeof notifications.$inferInsert> = { status: to };
  if (!row.readAt) patch.readAt = now;
  if (to === "actioned" || to === "done") patch.actionedAt = row.actionedAt ?? now;
  if (to === "done") patch.doneAt = now;
  const [updated] = await db.update(notifications).set(patch).where(eq(notifications.id, id)).returning();
  return updated!;
}

export function markRead(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}) {
  return advance(ctx, id, "read", opts);
}
export function markActioned(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}) {
  return advance(ctx, id, "actioned", opts);
}
export function markDone(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}) {
  return advance(ctx, id, "done", opts);
}

/** Tandai semua notifikasi Baru milik pengguna sebagai Dibaca. */
export async function markAllRead(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<number> {
  const userId = requireUser(ctx);
  const db = opts.tx ?? getDb();
  const rows = await db
    .update(notifications)
    .set({ status: "read", readAt: ctx.now ?? new Date() })
    .where(and(eq(notifications.recipientUserId, userId), eq(notifications.status, "new")))
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * Tandai "Ditindaklanjuti" semua notifikasi terkait objek (semua penerima) — dipanggil modul saat objek diputuskan
 * (mis. selisih diputuskan, persetujuan diputuskan).
 */
export async function markActionedForObject(
  tx: Tx,
  input: { objectType: string; objectId: string; events?: string[]; now?: Date },
): Promise<number> {
  const where: SQL[] = [
    eq(notifications.objectType, input.objectType),
    eq(notifications.objectId, input.objectId),
    inArray(notifications.status, ["new", "read"]),
  ];
  if (input.events?.length) where.push(inArray(notifications.event, input.events));
  const now = input.now ?? new Date();
  const rows = await tx
    .update(notifications)
    .set({ status: "actioned", actionedAt: now, readAt: sql`coalesce(${notifications.readAt}, ${now})` })
    .where(and(...where))
    .returning({ id: notifications.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Preferensi (US-M9-04 KP-3)
// ---------------------------------------------------------------------------------------------------------------------

export type NotificationPreferenceView = {
  event: string;
  label: string;
  severity: NotificationSeverity;
  mode: NotificationMode;
  canDisable: boolean;
};

/** Preferensi pengguna untuk seluruh katalog + jam tenang (null = bawaan PAR-56). */
export async function getPreferences(
  ctx: ActorContext,
  opts: { tx?: Tx } = {},
): Promise<{ items: NotificationPreferenceView[]; quietHours: { start: string; end: string } | null }> {
  const userId = requireUser(ctx);
  const db = opts.tx ?? getDb();
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  const byEvent = new Map(rows.map((r) => [r.event, r]));
  const quietRow = byEvent.get(QUIET_EVENT_KEY);
  const items = NOTIFICATION_EVENTS.map((ev) => ({
    event: ev.code,
    label: ev.label,
    severity: ev.severity,
    mode: ev.severity === "critical" ? "immediate" : ((byEvent.get(ev.code)?.mode as NotificationMode | undefined) ?? "immediate"),
    canDisable: ev.severity !== "critical",
  }));
  const quietHours =
    quietRow?.quietStart && quietRow.quietEnd ? { start: quietRow.quietStart.slice(0, 5), end: quietRow.quietEnd.slice(0, 5) } : null;
  return { items, quietHours };
}

/** Atur mode satu jenis notifikasi. Kritis selalu seketika (tidak dapat dimatikan / diringkas). */
export async function setPreference(ctx: ActorContext, event: string, mode: NotificationMode, opts: { tx?: Tx } = {}) {
  const userId = requireUser(ctx);
  requireEvent(event);
  if (!["immediate", "daily_digest", "off"].includes(mode)) throw ValidationError.field("mode", "Pilihan tidak valid.");
  if (!canDisable(event) && mode !== "immediate") {
    throw ValidationError.field("mode", "Notifikasi kritis selalu dikirim seketika dan tidak dapat dimatikan.");
  }
  const db = opts.tx ?? getDb();
  const [row] = await db
    .insert(notificationPreferences)
    .values({ userId, event, mode })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.event],
      set: { mode, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Atur jam tenang pribadi untuk notifikasi non-kritis (`null` = kembali ke bawaan PAR-56). */
export async function setQuietHours(ctx: ActorContext, hours: { start: string; end: string } | null, opts: { tx?: Tx } = {}) {
  const userId = requireUser(ctx);
  if (hours && (!HHMM.test(hours.start) || !HHMM.test(hours.end))) {
    throw ValidationError.field("quietHours", "Jam harus berformat HH:mm (mis. 22:00).");
  }
  const db = opts.tx ?? getDb();
  const [row] = await db
    .insert(notificationPreferences)
    .values({ userId, event: QUIET_EVENT_KEY, mode: "immediate", quietStart: hours?.start ?? null, quietEnd: hours?.end ?? null })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.event],
      set: { quietStart: hours?.start ?? null, quietEnd: hours?.end ?? null, updatedAt: new Date() },
    })
    .returning();
  return row!;
}
