/**
 * Pembantu uji M10: karyawan baru tanpa akun, pencarian cepat baris, dan waktu uji.
 */
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { accessLogs, auditLogs, employees, notifications } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";

let n = 0;

/** Karyawan aktif baru (master M1) tanpa akun. */
export async function newEmployee(db: DbOrTx, opts: { fullName?: string; exitDate?: string | null; tenantId?: string } = {}): Promise<string> {
  n++;
  const id = newId();
  await db.insert(employees).values({
    id,
    tenantId: opts.tenantId ?? EQUA_TENANT_ID,
    employeeNo: `M10-${n}-${id.slice(-5)}`,
    fullName: opts.fullName ?? `Karyawan Uji M10 ${n}`,
    position: "Uji",
    exitDate: opts.exitDate ?? null,
  });
  return id;
}

export async function notificationsOf(db: DbOrTx, username: string, event: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, userIdByUsername(username)), eq(notifications.event, event)));
}

export async function auditOf(db: DbOrTx, objectType: string, objectId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.objectType, objectType), eq(auditLogs.objectId, objectId)));
}

export async function accessLogsOf(db: DbOrTx, userId: string, event?: string) {
  const rows = await db.select().from(accessLogs).where(eq(accessLogs.userId, userId));
  return event ? rows.filter((r) => r.event === event) : rows;
}

export function uniqueName(prefix: string): string {
  n++;
  return `${prefix}${n}${Math.random().toString(36).slice(2, 6)}`;
}
