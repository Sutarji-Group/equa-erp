/**
 * Ringkasan e-mail harian ke pemilik setelah tutup kas (US-M9-04 KP-3; PAR-55 jam kirim; PTB-05 e-mail sebagai
 * cadangan). Penerima dari parameter `notifications.digest_recipients` (diatur pemilik). Dijalankan job
 * `core.notifications.daily_digest`.
 */
import "server-only";

import { and, count, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";

import { approvalRequests, notifications, userRoles, users } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { businessDateToUtcRange, formatTanggal, toBusinessDate } from "@/lib/time";

import { EQUA_TENANT_ID } from "../context";
import { getDb, type Tx } from "../db";
import { get as getParam } from "../params-read";
import { sendEmail } from "./channels/email";

export type DigestResult = {
  sent: boolean;
  recipients: string[];
  notificationCount: number;
  pendingApprovals: number;
  overdueApprovals: number;
  reason?: string;
};

/** Susun & kirim ringkasan harian untuk tanggal bisnis `now` (WIB). */
export async function sendDailyDigest(now: Date = new Date(), options: { tenantId?: string; db?: Tx } = {}): Promise<DigestResult> {
  const db = options.db ?? getDb();
  const tenantId = options.tenantId ?? EQUA_TENANT_ID;
  const businessDate = toBusinessDate(now);
  const { start, end } = businessDateToUtcRange(businessDate);
  const { emails } = await getParam(db, "notifications.digest_recipients", businessDate);

  const ownerIds = (
    await db
      .selectDistinct({ id: users.id })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(eq(users.tenantId, tenantId), eq(users.status, "active"), eq(userRoles.role, "owner"), eq(userRoles.status, "active")))
  ).map((r) => r.id);

  const todays = ownerIds.length
    ? await db
        .select()
        .from(notifications)
        .where(
          and(
            inArray(notifications.recipientUserId, ownerIds),
            gte(notifications.createdAt, start),
            lt(notifications.createdAt, end),
            isNull(notifications.emailedAt),
          ),
        )
    : [];

  const pending = await db
    .select({ n: count() })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.status, "submitted")));
  const overdue = await db
    .select({ n: count() })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.status, "submitted"), lte(approvalRequests.deadlineAt, now)));

  const pendingApprovals = Number(pending[0]?.n ?? 0);
  const overdueApprovals = Number(overdue[0]?.n ?? 0);
  const base = { recipients: emails, notificationCount: todays.length, pendingApprovals, overdueApprovals };
  if (emails.length === 0) {
    return { ...base, sent: false, reason: "Belum ada penerima e-mail (parameter notifications.digest_recipients)." };
  }

  const critical = todays.filter((n) => n.severity === "critical");
  const lines = [
    `Ringkasan EQUA — ${formatTanggal(businessDate)}`,
    "",
    `Persetujuan menunggu keputusan: ${pendingApprovals} (lewat tenggat: ${overdueApprovals})`,
    `Notifikasi hari ini: ${todays.length} (kritis: ${critical.length})`,
    "",
    ...(critical.length ? ["Perlu perhatian segera:"] : []),
    ...critical.slice(0, 20).map((n) => `• ${n.title}${n.valueAmount != null ? ` — ${formatRupiah(n.valueAmount)}` : ""}`),
    ...(todays.length > critical.length ? ["", "Lainnya:"] : []),
    ...todays
      .filter((n) => n.severity !== "critical")
      .slice(0, 30)
      .map((n) => `• [${label("notification_severity", n.severity)}] ${n.title}`),
    "",
    "Buka EQUA untuk rincian dan tindakan: /beranda",
  ];
  const res = await sendEmail({ to: emails, subject: `Ringkasan harian EQUA — ${formatTanggal(businessDate)}`, text: lines.join("\n") });
  if (res.ok && todays.length) {
    await db
      .update(notifications)
      .set({ emailedAt: now })
      .where(inArray(
        notifications.id,
        todays.map((n) => n.id),
      ));
  }
  return { ...base, sent: res.ok, reason: res.error };
}
