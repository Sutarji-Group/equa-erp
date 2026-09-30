/**
 * Penulisan massal untuk pembangkit uji beban: INSERT banyak baris per pernyataan (dipotong agar jumlah parameter
 * < 32.767 — di atas itu koneksi PGlite 0.5 kehilangan sinkron protokol dan mengembalikan hasil kosong) + penulis jejak audit BERANTAI (hash sama persis dengan `src/server/core/audit.ts`
 * sehingga `verifyAuditChain` tetap lulus dan layanan yang menulis audit sesudahnya menyambung rantai yang sah).
 */
import { desc } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { DbOrTx } from "@/db/client";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { auditHashPayload, computeAuditHash } from "@/server/core/audit";

/** Batas parameter per pernyataan: < 32.767 (jumlah parameter Bind ditulis Int16 oleh sebagian klien, termasuk PGlite). */
const MAX_PARAMS = 30_000;

/** INSERT massal terpotong. Kembalikan jumlah baris. */
export async function insertMany<T extends PgTable>(tx: DbOrTx, table: T, rows: T["$inferInsert"][]): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = Math.max(1, Object.keys(rows[0] as object).length);
  const chunk = Math.max(1, Math.floor(MAX_PARAMS / columns));
  for (let i = 0; i < rows.length; i += chunk) {
    await tx.insert(table).values(rows.slice(i, i + chunk) as never);
  }
  return rows.length;
}

export type AuditDraft = {
  tenantId: string | null;
  serverTime: Date;
  deviceTime?: Date | null;
  actorUserId: string | null;
  actorEmployeeId?: string | null;
  actorRoles: string[] | null;
  actorDeviceId?: string | null;
  source: "web" | "field" | "pos" | "system";
  objectType: string;
  objectId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  rule?: string | null;
  businessDate?: string | null;
};

/** Penulis audit berantai: baris ditampung lalu ditulis urut (seq bigserial mengikuti urutan VALUES). */
export class AuditChain {
  private prevHash: string | null = null;
  private loaded = false;
  private pending: AuditDraft[] = [];
  written = 0;

  add(draft: AuditDraft): void {
    this.pending.push(draft);
  }

  get size(): number {
    return this.pending.length;
  }

  async flush(tx: DbOrTx): Promise<void> {
    if (!this.loaded) {
      const last = await tx.select({ hash: auditLogs.hash }).from(auditLogs).orderBy(desc(auditLogs.seq)).limit(1);
      this.prevHash = last[0]?.hash ?? null;
      this.loaded = true;
    }
    if (this.pending.length === 0) return;
    const rows: (typeof auditLogs.$inferInsert)[] = [];
    for (const d of this.pending) {
      const row = {
        id: newId(),
        tenantId: d.tenantId,
        serverTime: d.serverTime,
        deviceTime: d.deviceTime ?? null,
        actorUserId: d.actorUserId,
        actorEmployeeId: d.actorEmployeeId ?? null,
        actorRoles: (d.actorRoles?.length ? d.actorRoles : null) as (typeof auditLogs.$inferInsert)["actorRoles"],
        actorDeviceId: d.actorDeviceId ?? null,
        source: d.source,
        objectType: d.objectType,
        objectId: d.objectId,
        action: d.action,
        before: d.before === undefined ? null : (JSON.parse(JSON.stringify(d.before)) as Record<string, unknown>),
        after: d.after === undefined ? null : (JSON.parse(JSON.stringify(d.after)) as Record<string, unknown>),
        reason: d.reason ?? null,
        rule: d.rule ?? null,
        businessDate: d.businessDate ?? null,
      };
      const hash = computeAuditHash(this.prevHash, auditHashPayload(row as unknown as Parameters<typeof auditHashPayload>[0]));
      rows.push({ ...row, prevHash: this.prevHash, hash });
      this.prevHash = hash;
    }
    this.pending = [];
    this.written += await insertMany(tx, auditLogs, rows);
  }
}
