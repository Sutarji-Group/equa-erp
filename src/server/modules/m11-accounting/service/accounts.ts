/**
 * M11 — bagan akun & pusat laba (US-M11-01 KP-1): impor template akuntan (K9) dengan kode, nama, jenis, pusat laba
 * (L1 produksi air, L2 air truk, L3 depot per outlet, L4 toko, L5 kemitraan, SHARED umum/kantor); akun dinonaktifkan,
 * tidak dihapus; setiap perubahan berjejak (audit sebelum/sesudah).
 */
import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { accounts, eventAccountMappings, journalLines, profitCenters } from "@/db/schema";
import { enumValues, isEnumValue, type AccountType, type ProfitCenter } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { authorize, runService } from "@/server/core/rbac";

import type { AccountRow } from "./common";
import { parseBool, parseTable, pick } from "./import-parse";

const NORMAL_BY_TYPE: Record<AccountType, "debit" | "credit"> = { asset: "debit", expense: "debit", liability: "credit", equity: "credit", revenue: "credit" };

export type AccountListRow = AccountRow & { parentCode: string | null; lineCount: number; mappingCount: number };

/** Daftar bagan akun (termasuk nonaktif) + jumlah pemakaian. Izin `m11.account.read` (akuntan baca-saja). */
export async function listAccounts(ctx: ActorContext, filter: { includeInactive?: boolean } = {}, opts: { tx?: Tx } = {}): Promise<AccountListRow[]> {
  await authorize(ctx, "m11.account.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(accounts).where(eq(accounts.tenantId, ctx.tenantId)).orderBy(asc(accounts.code));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const usage = await tx
    .select({ accountId: journalLines.accountId, n: sql<number>`count(*)::int` })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(accounts.tenantId, ctx.tenantId))
    .groupBy(journalLines.accountId);
  const usageMap = new Map(usage.map((u) => [u.accountId, Number(u.n)]));
  const maps = await tx.select({ d: eventAccountMappings.debitAccountId, c: eventAccountMappings.creditAccountId }).from(eventAccountMappings).where(and(eq(eventAccountMappings.tenantId, ctx.tenantId), eq(eventAccountMappings.isActive, true)));
  const mapCount = new Map<string, number>();
  for (const m of maps) {
    mapCount.set(m.d, (mapCount.get(m.d) ?? 0) + 1);
    if (m.c !== m.d) mapCount.set(m.c, (mapCount.get(m.c) ?? 0) + 1);
  }
  return rows
    .filter((r) => filter.includeInactive !== false || r.isActive)
    .map((r) => ({ ...r, parentCode: r.parentId ? (byId.get(r.parentId)?.code ?? null) : null, lineCount: usageMap.get(r.id) ?? 0, mappingCount: mapCount.get(r.id) ?? 0 }));
}

export async function listProfitCenters(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.account.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx.select().from(profitCenters).where(eq(profitCenters.tenantId, ctx.tenantId)).orderBy(asc(profitCenters.code));
}

/** Pilihan akun untuk formulir (akun detail aktif). */
export async function accountOptions(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.account.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, profitCenter: accounts.profitCenter, isCash: accounts.isCash })
    .from(accounts)
    .where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.isActive, true), eq(accounts.isPostable, true)))
    .orderBy(asc(accounts.code));
  return rows;
}

const codeSchema = z
  .string()
  .trim()
  .regex(/^[0-9][0-9A-Za-z.-]{1,19}$/, { error: "Kode akun diawali angka (mis. 1-1101), maksimal 20 karakter." });

export const accountInputSchema = z
  .object({
    code: codeSchema,
    name: z.string().trim().min(3, { error: "Nama akun minimal 3 karakter." }).max(120),
    type: z.enum(enumValues("account_type"), { error: "Pilih jenis akun." }),
    normalBalance: z.enum(enumValues("normal_balance")).nullable().optional(),
    parentCode: z.string().trim().nullable().optional(),
    isPostable: z.boolean().default(true),
    profitCenter: z.enum(enumValues("profit_center")).nullable().optional(),
    isInternalTransfer: z.boolean().default(false),
    isCash: z.boolean().default(false),
    description: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

async function parentIdOf(tx: Tx, tenantId: string, parentCode: string | null | undefined): Promise<string | null> {
  if (!parentCode) return null;
  const [p] = await tx.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, parentCode))).limit(1);
  if (!p) throw new DomainError("PARENT_MISSING", `Akun induk ${parentCode} tidak ditemukan.`);
  return p.id;
}

function snapshot(a: AccountRow) {
  return { code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance, profitCenter: a.profitCenter, isPostable: a.isPostable, isInternalTransfer: a.isInternalTransfer, isCash: a.isCash, isActive: a.isActive };
}

/** Tambah akun (Admin Keuangan). */
export async function createAccount(ctx: ActorContext, input: z.input<typeof accountInputSchema>, opts: { tx?: Tx } = {}): Promise<AccountRow> {
  await authorize(ctx, "m11.account.create", { tx: opts.tx });
  const data = parseInput(accountInputSchema, input, { code: "Kode akun", name: "Nama akun", type: "Jenis akun" });
  return runService(ctx, opts, async (tx) => {
    const dup = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.code, data.code))).limit(1);
    if (dup[0]) throw new ConflictError("ACCOUNT_EXISTS", `Kode akun ${data.code} sudah dipakai.`);
    const [row] = await tx
      .insert(accounts)
      .values({
        tenantId: ctx.tenantId,
        code: data.code,
        name: data.name,
        type: data.type,
        normalBalance: data.normalBalance ?? NORMAL_BY_TYPE[data.type],
        parentId: await parentIdOf(tx, ctx.tenantId, data.parentCode),
        isPostable: data.isPostable,
        profitCenter: data.profitCenter ?? null,
        isInternalTransfer: data.isInternalTransfer,
        isCash: data.isCash,
        description: data.description ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "account", objectId: row!.id, action: "create", after: snapshot(row!), rule: "US-M11-01 KP-1" });
    return row!;
  });
}

const updateSchema = z
  .object({
    accountId: z.uuid(),
    name: z.string().trim().min(3).max(120).optional(),
    profitCenter: z.enum(enumValues("profit_center")).nullable().optional(),
    isInternalTransfer: z.boolean().optional(),
    isCash: z.boolean().optional(),
    description: z.string().trim().max(300).nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan perubahan wajib diisi (minimal 5 karakter)." }),
  })
  .strict();

/** Ubah atribut akun (kode & jenis tidak diubah — akun baru + nonaktifkan yang lama). Berjejak. */
export async function updateAccount(ctx: ActorContext, input: z.input<typeof updateSchema>, opts: { tx?: Tx } = {}): Promise<AccountRow> {
  await authorize(ctx, "m11.account.update", { tx: opts.tx });
  const data = parseInput(updateSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const [a] = await tx.select().from(accounts).where(and(eq(accounts.id, data.accountId), eq(accounts.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!a) throw new NotFoundError("Akun tidak ditemukan.");
    const patch: Partial<AccountRow> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.profitCenter !== undefined) patch.profitCenter = data.profitCenter;
    if (data.isInternalTransfer !== undefined) patch.isInternalTransfer = data.isInternalTransfer;
    if (data.isCash !== undefined) patch.isCash = data.isCash;
    if (data.description !== undefined) patch.description = data.description;
    const [row] = await tx
      .update(accounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(accounts.id, a.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "account", objectId: a.id, action: "update", before: snapshot(a), after: snapshot(row!), reason: data.reason, rule: "US-M11-01 KP-1" });
    return row!;
  });
}

const deactivateSchema = z.object({ accountId: z.uuid(), reason: z.string().trim().min(5, { error: "Alasan wajib diisi (minimal 5 karakter)." }) }).strict();

/** Nonaktifkan akun (tidak dihapus, BR/Bab 6.1). Pemetaan aktif yang memakainya harus diganti dulu. */
export async function deactivateAccount(ctx: ActorContext, input: z.input<typeof deactivateSchema>, opts: { tx?: Tx } = {}): Promise<AccountRow> {
  await authorize(ctx, "m11.account.deactivate", { tx: opts.tx });
  const data = parseInput(deactivateSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const [a] = await tx.select().from(accounts).where(and(eq(accounts.id, data.accountId), eq(accounts.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!a) throw new NotFoundError("Akun tidak ditemukan.");
    if (!a.isActive) throw new DomainError("ALREADY_INACTIVE", "Akun ini sudah nonaktif.");
    const used = await tx
      .select({ event: eventAccountMappings.eventKey, entry: eventAccountMappings.entryKey })
      .from(eventAccountMappings)
      .where(
        and(
          eq(eventAccountMappings.tenantId, ctx.tenantId),
          eq(eventAccountMappings.isActive, true),
          sql`(${eventAccountMappings.debitAccountId} = ${a.id} or ${eventAccountMappings.creditAccountId} = ${a.id})`,
        ),
      )
      .limit(3);
    if (used.length) {
      throw new DomainError(
        "ACCOUNT_MAPPED",
        `Akun ${a.code} masih dipakai pemetaan (${used.map((u) => `${u.event}/${u.entry}`).join(", ")}). Ganti pemetaannya dulu agar jurnal otomatis tidak masuk daftar tunggu.`,
      );
    }
    const [row] = await tx
      .update(accounts)
      .set({ isActive: false, deactivatedAt: ctx.now, deactivationReason: data.reason, updatedAt: new Date() })
      .where(eq(accounts.id, a.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "account", objectId: a.id, action: "deactivate", before: { isActive: true }, after: { isActive: false }, reason: data.reason, rule: "US-M11-01 KP-1" });
    return row!;
  });
}

/** Aktifkan kembali akun nonaktif. */
export async function reactivateAccount(ctx: ActorContext, input: z.input<typeof deactivateSchema>, opts: { tx?: Tx } = {}): Promise<AccountRow> {
  await authorize(ctx, "m11.account.update", { tx: opts.tx });
  const data = parseInput(deactivateSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const [a] = await tx.select().from(accounts).where(and(eq(accounts.id, data.accountId), eq(accounts.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!a) throw new NotFoundError("Akun tidak ditemukan.");
    if (a.isActive) throw new DomainError("ALREADY_ACTIVE", "Akun ini sudah aktif.");
    const [row] = await tx.update(accounts).set({ isActive: true, deactivatedAt: null, deactivationReason: null, updatedAt: new Date() }).where(eq(accounts.id, a.id)).returning();
    await auditRecord(tx, { ctx, objectType: "account", objectId: a.id, action: "activate", before: { isActive: false }, after: { isActive: true }, reason: data.reason, rule: "US-M11-01 KP-1" });
    return row!;
  });
}

// =====================================================================================================================
// Impor template akuntan (K9)
// =====================================================================================================================

const TYPE_ALIASES: Record<string, AccountType> = {
  aset: "asset",
  aktiva: "asset",
  asset: "asset",
  liabilitas: "liability",
  kewajiban: "liability",
  utang: "liability",
  liability: "liability",
  ekuitas: "equity",
  modal: "equity",
  equity: "equity",
  pendapatan: "revenue",
  revenue: "revenue",
  beban: "expense",
  biaya: "expense",
  expense: "expense",
};

export type AccountImportRow = {
  line: number;
  code: string;
  name: string;
  type: AccountType | null;
  profitCenter: ProfitCenter | null;
  parentCode: string | null;
  isPostable: boolean;
  isInternalTransfer: boolean;
  isCash: boolean;
  normalBalance: "debit" | "credit" | null;
  action: "create" | "update" | "error";
  errors: string[];
};

export type AccountImportResult = { rows: AccountImportRow[]; created: number; updated: number; errors: number; committed: boolean };

const importSchema = z
  .object({
    fileName: z.string().min(1),
    content: z.union([z.string(), z.instanceof(Buffer)]),
    commit: z.boolean().default(false),
    reason: z.string().trim().min(5, { error: "Alasan impor wajib diisi (minimal 5 karakter)." }).optional(),
  })
  .strict();

/**
 * Impor bagan akun dari template akuntan (CSV/XLSX; kolom: Kode, Nama, Jenis, Pusat laba, Induk, Saldo normal, Header,
 * Internal, Kas). Pratinjau dulu (`commit: false`); saat `commit: true` akun baru dibuat & akun lama diperbarui
 * (nama/pusat laba/penanda) dengan jejak audit per akun.
 */
export async function importChartOfAccounts(ctx: ActorContext, input: z.input<typeof importSchema>, opts: { tx?: Tx } = {}): Promise<AccountImportResult> {
  await authorize(ctx, "m11.account.create", { tx: opts.tx });
  const data = parseInput(importSchema, input, { fileName: "Berkas", reason: "Alasan" });
  const table = await parseTable(data.fileName, data.content);
  return runService(ctx, opts, async (tx) => {
    const existing = await tx.select().from(accounts).where(eq(accounts.tenantId, ctx.tenantId));
    const byCode = new Map(existing.map((a) => [a.code, a]));
    const fileCodes = new Set<string>();
    const rows: AccountImportRow[] = table.rows.map((r, i) => {
      const errors: string[] = [];
      const code = pick(r, ["kode", "kode akun", "code"]);
      const name = pick(r, ["nama", "nama akun", "name"]);
      const typeRaw = pick(r, ["jenis", "tipe", "type"]).toLowerCase();
      const pcRaw = pick(r, ["pusat laba", "lini", "profit center"]).toUpperCase().replace(/^UMUM$|^KANTOR$|^BERSAMA$/, "SHARED");
      const type = TYPE_ALIASES[typeRaw] ?? null;
      if (!codeSchema.safeParse(code).success) errors.push("Kode akun tidak valid");
      if (name.length < 3) errors.push("Nama akun kosong/terlalu pendek");
      if (!type) errors.push(`Jenis "${typeRaw || "—"}" tidak dikenal (Aset/Liabilitas/Ekuitas/Pendapatan/Beban)`);
      const profitCenter = pcRaw ? (isEnumValue("profit_center", pcRaw) ? (pcRaw as ProfitCenter) : null) : null;
      if (pcRaw && !profitCenter) errors.push(`Pusat laba "${pcRaw}" tidak dikenal (L1–L5 atau SHARED)`);
      if (fileCodes.has(code)) errors.push("Kode akun ganda di berkas");
      fileCodes.add(code);
      const normalRaw = pick(r, ["saldo normal", "normal"]).toLowerCase();
      const normalBalance = normalRaw.startsWith("d") ? "debit" : normalRaw.startsWith("k") || normalRaw.startsWith("c") ? "credit" : null;
      return {
        line: i + 2,
        code,
        name,
        type,
        profitCenter,
        parentCode: pick(r, ["induk", "kode induk", "parent"]) || null,
        isPostable: !parseBool(pick(r, ["header", "akun induk"])),
        isInternalTransfer: parseBool(pick(r, ["internal", "transfer internal"])),
        isCash: parseBool(pick(r, ["kas", "kas/bank", "cash"])),
        normalBalance,
        action: errors.length ? "error" : byCode.has(code) ? "update" : "create",
        errors,
      };
    });
    for (const row of rows) {
      if (row.parentCode && !byCode.has(row.parentCode) && !fileCodes.has(row.parentCode)) {
        row.errors.push(`Akun induk ${row.parentCode} tidak ada`);
        row.action = "error";
      }
      const prev = byCode.get(row.code);
      if (prev && row.type && prev.type !== row.type) {
        row.errors.push(`Jenis akun ${row.code} berbeda dengan yang tercatat — buat akun baru lalu nonaktifkan yang lama`);
        row.action = "error";
      }
    }
    const errors = rows.filter((r) => r.action === "error").length;
    const result: AccountImportResult = { rows, created: rows.filter((r) => r.action === "create").length, updated: rows.filter((r) => r.action === "update").length, errors, committed: false };
    if (!data.commit) return result;
    if (errors) throw new DomainError("IMPORT_ERRORS", `Masih ada ${errors} baris bermasalah. Perbaiki berkas lalu impor ulang.`);
    if (!data.reason) throw new DomainError("REASON_REQUIRED", "Alasan impor wajib diisi.");
    // Buat dulu semua akun (induk sebelum anak: urut kode), lalu isi induk.
    const ordered = [...rows].sort((a, b) => a.code.localeCompare(b.code));
    for (const r of ordered) {
      const prev = byCode.get(r.code);
      if (prev) {
        const [row] = await tx
          .update(accounts)
          .set({ name: r.name, profitCenter: r.profitCenter, isInternalTransfer: r.isInternalTransfer, isCash: r.isCash, updatedAt: new Date() })
          .where(eq(accounts.id, prev.id))
          .returning();
        await auditRecord(tx, { ctx, objectType: "account", objectId: prev.id, action: "update", before: snapshot(prev), after: snapshot(row!), reason: data.reason, rule: "US-M11-01 KP-1 (impor K9)" });
        byCode.set(r.code, row!);
      } else {
        const [row] = await tx
          .insert(accounts)
          .values({
            tenantId: ctx.tenantId,
            code: r.code,
            name: r.name,
            type: r.type!,
            normalBalance: r.normalBalance ?? NORMAL_BY_TYPE[r.type!],
            isPostable: r.isPostable,
            profitCenter: r.profitCenter,
            isInternalTransfer: r.isInternalTransfer,
            isCash: r.isCash,
            createdBy: ctx.userId,
          })
          .returning();
        await auditRecord(tx, { ctx, objectType: "account", objectId: row!.id, action: "create", after: snapshot(row!), reason: data.reason, rule: "US-M11-01 KP-1 (impor K9)" });
        byCode.set(r.code, row!);
      }
    }
    const parentUpdates = ordered.filter((r) => r.parentCode);
    const ids = parentUpdates.map((r) => byCode.get(r.code)!.id);
    if (ids.length) {
      for (const r of parentUpdates) {
        await tx
          .update(accounts)
          .set({ parentId: byCode.get(r.parentCode!)!.id })
          .where(and(inArray(accounts.id, [byCode.get(r.code)!.id])));
      }
    }
    return { ...result, committed: true };
  });
}
