/**
 * M11 — pemetaan peristiwa → akun (US-M11-01 KP-2): dikelola Admin Keuangan (akuntan meninjau, baca-saja); berlaku KE
 * DEPAN (`effective_from`, 7.11.7 — jurnal lama tidak diposting ulang); setiap perubahan berjejak. Setiap peristiwa
 * 7.11.4 wajib terpetakan sebelum M11 diaktifkan (flag `accounting.m11_active`, pemilik); setelah pemetaan dilengkapi,
 * antrean peristiwa terkait diproses ulang otomatis.
 */
import "server-only";

import { and, asc, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";

import { accounts, eventAccountMappings } from "@/db/schema";
import { enumValues, type ProfitCenter } from "@/lib/labels";
import type { BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import * as flags from "@/server/core/flags";
import { authorize, runService } from "@/server/core/rbac";

import { REQUIRED_MAPPINGS, SKIPPED_EVENTS, type RequiredMapping } from "../constants";
import { m11Active } from "./common";
import { retryPendingQueue, type RetrySummary } from "./queue";

export type MappingRow = typeof eventAccountMappings.$inferSelect;

export type MappingView = RequiredMapping & {
  current: (MappingRow & { debitCode: string; debitName: string; creditCode: string; creditName: string; debitActive: boolean; creditActive: boolean }) | null;
  history: MappingRow[];
  status: "ok" | "missing" | "inactive_account";
};

async function mappingRows(tx: Tx, tenantId: string, date: BusinessDate) {
  const rows = await tx
    .select()
    .from(eventAccountMappings)
    .where(and(eq(eventAccountMappings.tenantId, tenantId), lte(eventAccountMappings.effectiveFrom, "9999-12-31")))
    .orderBy(asc(eventAccountMappings.eventKey), asc(eventAccountMappings.entryKey), desc(eventAccountMappings.effectiveFrom));
  const accs = await tx.select().from(accounts).where(eq(accounts.tenantId, tenantId));
  const byId = new Map(accs.map((a) => [a.id, a]));
  const current = new Map<string, MappingRow>();
  const history = new Map<string, MappingRow[]>();
  for (const r of rows) {
    const key = `${r.eventKey}|${r.entryKey}`;
    history.set(key, [...(history.get(key) ?? []), r]);
    if (!current.has(key) && r.isActive && r.effectiveFrom <= date) current.set(key, r);
  }
  return { current, history, byId };
}

/** Status pemetaan wajib per tanggal (layar pemetaan & syarat aktivasi). */
export async function mappingCompleteness(tx: Tx, tenantId: string, date: BusinessDate): Promise<{ total: number; missing: RequiredMapping[]; inactive: RequiredMapping[] }> {
  const { current, byId } = await mappingRows(tx, tenantId, date);
  const missing: RequiredMapping[] = [];
  const inactive: RequiredMapping[] = [];
  for (const req of REQUIRED_MAPPINGS) {
    const cur = current.get(`${req.event}|${req.entry}`);
    if (!cur) {
      missing.push(req);
      continue;
    }
    const d = byId.get(cur.debitAccountId);
    const c = byId.get(cur.creditAccountId);
    if (!d?.isActive || !c?.isActive || !d.isPostable || !c.isPostable) inactive.push(req);
  }
  return { total: REQUIRED_MAPPINGS.length, missing, inactive };
}

/** Daftar pemetaan wajib + versi berlaku + riwayat. Izin `m11.journal_mapping.read`. */
export async function listMappings(ctx: ActorContext, filter: { date?: BusinessDate | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.journal_mapping.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const date = filter.date ?? ctxBusinessDate(ctx);
  const { current, history, byId } = await mappingRows(tx, ctx.tenantId, date);
  const views: MappingView[] = REQUIRED_MAPPINGS.map((req) => {
    const key = `${req.event}|${req.entry}`;
    const cur = current.get(key) ?? null;
    const d = cur ? byId.get(cur.debitAccountId) : undefined;
    const c = cur ? byId.get(cur.creditAccountId) : undefined;
    const ok = !!cur && !!d?.isActive && !!c?.isActive && !!d?.isPostable && !!c?.isPostable;
    return {
      ...req,
      current: cur
        ? { ...cur, debitCode: d?.code ?? "?", debitName: d?.name ?? "?", creditCode: c?.code ?? "?", creditName: c?.name ?? "?", debitActive: !!d?.isActive, creditActive: !!c?.isActive }
        : null,
      history: history.get(key) ?? [],
      status: !cur ? "missing" : ok ? "ok" : "inactive_account",
    };
  });
  const extra = [...current.values()].filter((r) => !REQUIRED_MAPPINGS.some((q) => q.event === r.eventKey && q.entry === r.entryKey));
  return {
    date,
    active: await m11Active(tx, ctx.tenantId),
    mappings: views,
    extra,
    skipped: SKIPPED_EVENTS,
    missingCount: views.filter((v) => v.status !== "ok").length,
  };
}

export const mappingInputSchema = z
  .object({
    eventKey: z.string().trim().min(3),
    entryKey: z.string().trim().min(1),
    description: z.string().trim().min(3, { error: "Keterangan pemetaan minimal 3 karakter." }).max(200),
    debitAccountId: z.uuid({ error: "Pilih akun debit." }),
    creditAccountId: z.uuid({ error: "Pilih akun kredit." }),
    debitProfitCenter: z.enum(enumValues("profit_center")).nullable().optional(),
    creditProfitCenter: z.enum(enumValues("profit_center")).nullable().optional(),
    profitCenterRule: z.enum(["fixed", "from_outlet", "from_source", "split_internal"]).default("fixed"),
    effectiveFrom: z.string().refine((d) => /^\d{4}-\d{2}-\d{2}$/.test(d), { error: "Tanggal berlaku harus YYYY-MM-DD." }),
    reason: z.string().trim().min(5, { error: "Alasan perubahan wajib diisi (minimal 5 karakter)." }),
  })
  .strict();

/**
 * Simpan pemetaan (versi baru berlaku mulai `effectiveFrom` ≥ hari ini; versi yang sama tanggalnya diperbarui).
 * Berjejak; antrean menunggu untuk peristiwa ini diproses ulang otomatis.
 */
export async function saveMapping(ctx: ActorContext, input: z.input<typeof mappingInputSchema>, opts: { tx?: Tx } = {}): Promise<{ mapping: MappingRow; retried: RetrySummary }> {
  await authorize(ctx, "m11.journal_mapping.update", { tx: opts.tx });
  const data = parseInput(mappingInputSchema, input, { debitAccountId: "Akun debit", creditAccountId: "Akun kredit", effectiveFrom: "Tanggal berlaku", reason: "Alasan" });
  const today = ctxBusinessDate(ctx);
  if (data.effectiveFrom < today) {
    throw new DomainError("MAPPING_RETROACTIVE", "Pemetaan berlaku ke depan (mulai hari ini atau sesudahnya). Jurnal lama dikoreksi lewat jurnal reklasifikasi beralasan.");
  }
  return runService(ctx, opts, async (tx) => {
    const accs = await tx.select().from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId)));
    const byId = new Map(accs.map((a) => [a.id, a]));
    for (const id of [data.debitAccountId, data.creditAccountId]) {
      const a = byId.get(id);
      if (!a) throw new NotFoundError("Akun pemetaan tidak ditemukan di bagan akun.");
      if (!a.isActive || !a.isPostable) throw new DomainError("ACCOUNT_INACTIVE", `Akun ${a.code} ${a.name} nonaktif atau akun induk — pilih akun detail yang aktif.`);
    }
    const [same] = await tx
      .select()
      .from(eventAccountMappings)
      .where(
        and(
          eq(eventAccountMappings.tenantId, ctx.tenantId),
          eq(eventAccountMappings.eventKey, data.eventKey),
          eq(eventAccountMappings.entryKey, data.entryKey),
          eq(eventAccountMappings.effectiveFrom, data.effectiveFrom),
        ),
      )
      .limit(1);
    const [prev] = await tx
      .select()
      .from(eventAccountMappings)
      .where(and(eq(eventAccountMappings.tenantId, ctx.tenantId), eq(eventAccountMappings.eventKey, data.eventKey), eq(eventAccountMappings.entryKey, data.entryKey), lte(eventAccountMappings.effectiveFrom, data.effectiveFrom)))
      .orderBy(desc(eventAccountMappings.effectiveFrom))
      .limit(1);
    const values = {
      description: data.description,
      debitAccountId: data.debitAccountId,
      creditAccountId: data.creditAccountId,
      debitProfitCenter: (data.debitProfitCenter ?? null) as ProfitCenter | null,
      creditProfitCenter: (data.creditProfitCenter ?? null) as ProfitCenter | null,
      profitCenterRule: data.profitCenterRule,
      isActive: true,
    };
    const [row] = same
      ? await tx.update(eventAccountMappings).set({ ...values, updatedAt: new Date() }).where(eq(eventAccountMappings.id, same.id)).returning()
      : await tx
          .insert(eventAccountMappings)
          .values({ tenantId: ctx.tenantId, eventKey: data.eventKey, entryKey: data.entryKey, effectiveFrom: data.effectiveFrom, createdBy: ctx.userId, ...values })
          .returning();
    const describe = (m: MappingRow | undefined) =>
      m ? { debit: byId.get(m.debitAccountId)?.code, credit: byId.get(m.creditAccountId)?.code, debitPc: m.debitProfitCenter, creditPc: m.creditProfitCenter, rule: m.profitCenterRule, effectiveFrom: m.effectiveFrom } : null;
    await auditRecord(tx, {
      ctx,
      objectType: "event_account_mapping",
      objectId: row!.id,
      action: same ? "update" : "create",
      before: describe(same ?? prev),
      after: describe(row!),
      reason: data.reason,
      rule: "US-M11-01 KP-2",
    });
    const retried = data.effectiveFrom <= today ? await retryPendingQueue(tx, ctx.tenantId, { eventKeys: [data.eventKey], today }) : { tried: 0, posted: 0, stillQueued: 0, skipped: 0, errors: [] };
    return { mapping: row!, retried };
  });
}

const activateSchema = z.object({ enabled: z.boolean(), reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }) }).strict();

/**
 * Aktifkan/nonaktifkan jurnal otomatis M11 (pemilik; flag `accounting.m11_active` lingkup tenant). Aktivasi DITOLAK
 * bila masih ada pemetaan wajib yang hilang/akunnya nonaktif (US-M11-01 KP-2).
 */
export async function setAccountingActive(ctx: ActorContext, input: z.input<typeof activateSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.accounting.activate", { tx: opts.tx });
  const data = parseInput(activateSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    if (data.enabled) {
      const comp = await mappingCompleteness(tx, ctx.tenantId, ctxBusinessDate(ctx));
      const problems = [...comp.missing, ...comp.inactive];
      if (problems.length) {
        throw new DomainError(
          "MAPPING_INCOMPLETE",
          `M11 belum dapat diaktifkan: ${problems.length} pemetaan wajib belum lengkap (${problems
            .slice(0, 5)
            .map((p) => `${p.event}/${p.entry}`)
            .join(", ")}${problems.length > 5 ? ", …" : ""}). Lengkapi di Akuntansi > Pemetaan jurnal otomatis.`,
        );
      }
    }
    await flags.set(ctx, "accounting.m11_active", data.enabled, { scope: { type: "tenant", refId: ctx.tenantId }, reason: data.reason }, { tx });
    return { enabled: data.enabled };
  });
}
