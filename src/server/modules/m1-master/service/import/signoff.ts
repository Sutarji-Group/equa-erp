/**
 * M1 — tanda tangan data awal per kelompok (US-M1-06 KP-4/KP-6, NFR-34, 6.2b): setiap impor PRODUKSI memperbarui draf
 * ringkasan kelompoknya (pelanggan; zona & harga; armada/kru/karyawan; depot & sumber air). Pemilik menandatangani di
 * sistem sebelum go-live. Menandatangani ringkasan pelanggan MENETAPKAN status "Tempo migrasi" beserta batas & tempo
 * yang disepakati (satu-satunya pengecualian BR-01; keputusan langsung pemilik 6.2b, diberitahukan ke Admin Keuangan).
 */
import "server-only";

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import { dataSignoffs, importBatches } from "@/db/schema";
import { label, type DataSignoffGroup } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";

import { record as auditRecord } from "@/server/core/audit";
import { type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { assertTenantScope, authorize, authorizeAny, runService } from "@/server/core/rbac";

import { loadCustomer } from "../common";
import { setCreditStatus } from "../credit";
import { coordinateLockProgress } from "../customers";

export const M1_SIGNOFF_GROUPS: readonly DataSignoffGroup[] = ["customers", "tariffs_prices", "fleet_people", "outlets_sources"];

type BatchRow = typeof importBatches.$inferSelect;
type SignoffRow = typeof dataSignoffs.$inferSelect;

/** Perbarui (atau buat) draf tanda tangan kelompok setelah impor produksi. Mengembalikan ID draf. */
export async function refreshSignoffDraft(tx: Tx, ctx: ActorContext, group: DataSignoffGroup, batch: BatchRow, summary: Record<string, unknown>): Promise<string> {
  const latest = await tx
    .select()
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, batch.tenantId), eq(dataSignoffs.group, group), ne(dataSignoffs.status, "superseded")))
    .orderBy(desc(dataSignoffs.createdAt))
    .limit(1);
  const current = latest[0];
  const kinds = { ...(((current?.status === "draft" ? current.summary : current?.summary) ?? {}) as { kinds?: Record<string, unknown> }).kinds, [batch.kind]: { batchId: batch.id, ...summary } };
  const nextSummary = { kinds, updatedAt: ctx.now.toISOString() };
  let id: string;
  if (current && current.status === "draft") {
    await tx.update(dataSignoffs).set({ summary: nextSummary, importBatchId: batch.id }).where(eq(dataSignoffs.id, current.id));
    id = current.id;
  } else {
    const [row] = await tx
      .insert(dataSignoffs)
      .values({
        tenantId: batch.tenantId,
        group,
        title: `Ringkasan data awal — ${label("data_signoff_group", group)}`,
        summary: nextSummary,
        status: "draft",
        importBatchId: batch.id,
        supersedesId: current?.id ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    id = row!.id;
  }
  await auditRecord(tx, { ctx, objectType: "data_signoff", objectId: id, action: "update", after: { group, kind: batch.kind, batchId: batch.id }, rule: "NFR-34" });
  await notify(tx, {
    event: "initial_data.signoff_pending",
    tenantId: batch.tenantId,
    title: `Data awal menunggu tanda tangan: ${label("data_signoff_group", group)}`,
    body: `Impor ${label("import_kind", batch.kind)} selesai. Tinjau ringkasan dan tanda tangani sebelum go-live.`,
    objectType: "data_signoff",
    objectId: id,
    link: "/master/tanda-tangan",
    groupKey: `signoff:${batch.tenantId}:${group}`,
    now: ctx.now,
  });
  return id;
}

const signSchema = z.object({ note: z.string().trim().max(500).optional() });

/**
 * Pemilik menandatangani ringkasan data awal (NFR-34). Untuk kelompok pelanggan: pelanggan "Tempo migrasi" pada
 * ringkasan ditetapkan statusnya (6.2b; riwayat kredit + audit + event) dan Admin Keuangan diberi tahu.
 */
export async function signDataSignoff(ctx: ActorContext, signoffId: string, input: z.input<typeof signSchema> = {}, opts: { tx?: Tx } = {}): Promise<SignoffRow> {
  await authorize(ctx, "m1.data_signoff.sign", { tx: opts.tx, objectType: "data_signoff", objectId: signoffId });
  const data = parseInput(signSchema, input);
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(dataSignoffs).where(eq(dataSignoffs.id, signoffId)).for("update").limit(1);
    const signoff = rows[0];
    if (!signoff) throw new NotFoundError("Ringkasan data awal tidak ditemukan.");
    assertTenantScope(ctx, signoff.tenantId);
    if (!M1_SIGNOFF_GROUPS.includes(signoff.group)) throw new DomainError("SIGNOFF_GROUP", "Kelompok ini ditandatangani di modulnya sendiri.");
    if (signoff.status !== "draft") throw new ConflictError("SIGNOFF_NOT_DRAFT", `Ringkasan ini sudah ${label("signoff_status", signoff.status).toLowerCase()}.`);
    const applied: { code: string; name: string; creditLimit: number; paymentTermDays: number }[] = [];
    if (signoff.group === "customers") {
      const kinds = ((signoff.summary ?? {}) as { kinds?: Record<string, { tempoMigrasi?: { customerId: string; code: string; name: string; creditLimit: number; paymentTermDays: number }[] }> }).kinds ?? {};
      for (const t of kinds.customers?.tempoMigrasi ?? []) {
        const customer = await loadCustomer(tx, null, t.customerId, { forUpdate: true });
        if (customer.creditStatus !== "cash" || customer.segment === "household") continue;
        await setCreditStatus(tx, ctx, customer, {
          to: "credit_migrated",
          creditLimit: t.creditLimit,
          paymentTermDays: t.paymentTermDays,
          reason: "Tempo migrasi pelanggan lama — bagian tanda tangan data awal (US-M1-06 KP-6, NFR-34).",
          rule: "US-M1-06 KP-6",
        });
        applied.push(t);
      }
    }
    if (signoff.supersedesId) await tx.update(dataSignoffs).set({ status: "superseded" }).where(eq(dataSignoffs.id, signoff.supersedesId));
    const [after] = await tx
      .update(dataSignoffs)
      .set({ status: "signed", signedBy: ctx.userId, signedAt: ctx.now, notes: data.note ?? signoff.notes })
      .where(eq(dataSignoffs.id, signoffId))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "data_signoff",
      objectId: signoffId,
      action: "sign",
      before: { status: "draft" },
      after: { status: "signed", tempoMigrasiApplied: applied.length },
      reason: data.note ?? null,
      rule: "NFR-34, 6.2b",
    });
    if (applied.length) {
      await notify(tx, {
        event: "credit.migrated_set",
        tenantId: signoff.tenantId,
        recipients: { roles: ["finance_admin"] },
        title: `Tempo migrasi ditetapkan untuk ${applied.length} pelanggan`,
        body: applied
          .slice(0, 5)
          .map((a) => `${a.name}: batas ${formatRupiah(a.creditLimit)}, tempo ${a.paymentTermDays} hari`)
          .join("; "),
        link: "/master/tanda-tangan",
        now: ctx.now,
      });
    }
    return after!;
  });
}

/** Daftar ringkasan data awal M1 (terbaru per kelompok + riwayat). */
export async function listSignoffs(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<SignoffRow[]> {
  await authorizeAny(ctx, ["m1.data_signoff.read", "m1.import.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx
    .select()
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, ctx.tenantId), inArray(dataSignoffs.group, [...M1_SIGNOFF_GROUPS])))
    .orderBy(desc(dataSignoffs.createdAt));
}

export type InitialDataStatus = {
  groups: { group: DataSignoffGroup; label: string; status: "none" | "draft" | "signed"; signoffId: string | null; signedAt: Date | null }[];
  allSigned: boolean;
  coordinates: Awaited<ReturnType<typeof coordinateLockProgress>>;
};

/** Status kesiapan go-live data awal M1 (US-M1-06 KP-4/KP-5). */
export async function initialDataStatus(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<InitialDataStatus> {
  const signoffs = await listSignoffs(ctx, opts);
  const groups = M1_SIGNOFF_GROUPS.map((group) => {
    const latest = signoffs.find((s) => s.group === group && s.status !== "superseded");
    return { group, label: label("data_signoff_group", group), status: (latest?.status ?? "none") as "none" | "draft" | "signed", signoffId: latest?.id ?? null, signedAt: latest?.signedAt ?? null };
  });
  const coordinates = await coordinateLockProgress(ctx, opts);
  return { groups, allSigned: groups.every((g) => g.status === "signed"), coordinates };
}
