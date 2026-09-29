/**
 * M10 — permintaan penghapusan data pribadi (UU PDP) lewat anonimisasi (US-M10-06 KP-2; NFR-12; BRD 10.6; PTB-36).
 *
 * Alur: admin sistem mencatat permintaan → pemilik menyetujui (`anonymization`, 6.2a) → sistem menganonimkan nama,
 * kontak (WA), alamat, dan koordinat pada seluruh objek (pelanggan, alamat kirim, rit, log WA, akun aplikasi
 * pelanggan) dan MENYIMPAN catatan transaksi keuangan tanpa identitas (faktur, pelunasan, jurnal tidak disentuh).
 * Pelanggan dengan piutang terbuka tidak dapat dianonimkan sebelum lunas/dihapuskan: permintaan berstatus
 * "Ditunda (piutang terbuka)", pemohon diberi tahu, dan dapat diajukan ulang setelah lunas (job harian memberi tahu).
 * Karyawan hanya dapat dianonimkan setelah keluar/nonaktif.
 */
import "server-only";

import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  anonymizationRequests,
  customerAccountRequests,
  customerAccounts,
  customerAddresses,
  customerSessions,
  customers,
  employees,
  invoices,
  otpCodes,
  phoneChangeRequests,
  trips,
  users,
  waMessageLogs,
} from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import * as approvals from "@/server/core/approvals";
import type { ApprovalHandlers } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";

import { userNames } from "./shared";

export type AnonymizationRow = typeof anonymizationRequests.$inferSelect;

/** Total piutang terbuka pelanggan (faktur Terbuka/Sebagian dibayar dengan sisa > 0). */
export async function openReceivableOf(tx: Tx, customerId: string): Promise<{ count: number; amount: number }> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${invoices.outstandingAmount}), 0)::bigint` })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), inArray(invoices.status, ["open", "partial"]), gt(invoices.outstandingAmount, 0)));
  return { count: Number(rows[0]?.n ?? 0), amount: Number(rows[0]?.total ?? 0) };
}

const requestSchema = z.object({
  subjectType: z.enum(["customer", "employee"], { error: "Pilih jenis subjek: pelanggan atau karyawan." }),
  subjectId: z.uuid({ error: "Pilih pelanggan/karyawan." }),
  reason: z.string().trim().min(5, { error: "Alasan/rujukan permintaan wajib diisi (minimal 5 karakter)." }).max(1000),
});

async function subjectInfo(tx: Tx, ctx: ActorContext, type: "customer" | "employee", id: string): Promise<{ name: string; anonymized: boolean }> {
  if (type === "customer") {
    const r = await tx.select({ name: customers.name, tenantId: customers.tenantId, anonymizedAt: customers.anonymizedAt }).from(customers).where(eq(customers.id, id)).limit(1);
    if (!r[0] || r[0].tenantId !== ctx.tenantId) throw new NotFoundError("Pelanggan tidak ditemukan.");
    return { name: r[0].name, anonymized: !!r[0].anonymizedAt };
  }
  const r = await tx
    .select({ name: employees.fullName, tenantId: employees.tenantId, anonymizedAt: employees.anonymizedAt, isActive: employees.isActive, exitDate: employees.exitDate })
    .from(employees)
    .where(eq(employees.id, id))
    .limit(1);
  if (!r[0] || r[0].tenantId !== ctx.tenantId) throw new NotFoundError("Karyawan tidak ditemukan.");
  const exited = !r[0].isActive || (!!r[0].exitDate && r[0].exitDate <= ctxBusinessDate(ctx));
  if (!exited) throw ValidationError.field("subjectId", "Karyawan masih aktif. Data karyawan hanya dapat dianonimkan setelah keluar (tanggal keluar di master M1).");
  return { name: r[0].name, anonymized: !!r[0].anonymizedAt };
}

/**
 * Admin sistem mencatat permintaan anonimisasi. Bila pelanggan masih berpiutang → dicatat "Ditunda" (tanpa
 * persetujuan) dan pemohon diberi tahu; bila tidak → diajukan ke pemilik.
 */
export async function requestAnonymization(ctx: ActorContext, input: z.input<typeof requestSchema>, opts: { tx?: Tx } = {}): Promise<{ request: AnonymizationRow; approval: approvals.ApprovalRow | null; deferredReason: string | null }> {
  await authorize(ctx, "m10.anonymization.request", { tx: opts.tx, objectType: "anonymization_request" });
  const data = parseInput(requestSchema, input, { subjectId: "Subjek", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const subject = await subjectInfo(tx, ctx, data.subjectType, data.subjectId);
    if (subject.anonymized) throw new ConflictError("ALREADY_ANONYMIZED", "Data subjek ini sudah dianonimkan.");
    const live = await tx
      .select({ id: anonymizationRequests.id })
      .from(anonymizationRequests)
      .where(and(eq(anonymizationRequests.subjectType, data.subjectType), eq(anonymizationRequests.subjectId, data.subjectId), inArray(anonymizationRequests.status, ["submitted", "approved", "deferred"])))
      .limit(1);
    if (live[0]) throw new ConflictError("ANONYMIZATION_OPEN", "Sudah ada permintaan anonimisasi yang berjalan untuk subjek ini.");
    const [row] = await tx
      .insert(anonymizationRequests)
      .values({ tenantId: ctx.tenantId, subjectType: data.subjectType, subjectId: data.subjectId, reason: data.reason, status: "submitted", createdBy: ctx.userId })
      .returning();
    const result = await submitOrDefer(tx, ctx, row!, subject.name);
    await auditRecord(tx, {
      ctx,
      objectType: "anonymization_request",
      objectId: row!.id,
      action: "create",
      after: { subjectType: data.subjectType, subjectId: data.subjectId, status: result.request.status, approval: result.approval?.number ?? null },
      reason: data.reason,
    });
    return result;
  });
}

async function submitOrDefer(tx: Tx, ctx: ActorContext, row: AnonymizationRow, subjectName: string) {
  if (row.subjectType === "customer") {
    const open = await openReceivableOf(tx, row.subjectId);
    if (open.count > 0) {
      const why = `Piutang terbuka ${formatRupiah(open.amount)} (${open.count} faktur). Anonimisasi ditunda sampai lunas atau dihapuskan (PTB-36).`;
      const [deferred] = await tx
        .update(anonymizationRequests)
        .set({ status: "deferred", blockedReason: why, updatedAt: ctx.now })
        .where(eq(anonymizationRequests.id, row.id))
        .returning();
      return { request: deferred!, approval: null, deferredReason: why };
    }
  }
  const approval = await approvals.submit(
    ctx,
    {
      type: "anonymization",
      objectType: "anonymization_request",
      objectId: row.id,
      reason: row.reason,
      payload: { subjectType: row.subjectType, subjectId: row.subjectId, subjectName, link: "/akses/data-pribadi" },
    },
    { tx },
  );
  const [updated] = await tx
    .update(anonymizationRequests)
    .set({ status: "submitted", approvalRequestId: approval.id, blockedReason: null, updatedAt: ctx.now })
    .where(eq(anonymizationRequests.id, row.id))
    .returning();
  return { request: updated!, approval, deferredReason: null };
}

/** Ajukan ulang permintaan yang ditunda (setelah piutang lunas/dihapuskan). */
export async function resubmitAnonymization(ctx: ActorContext, requestId: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.anonymization.request", { tx: opts.tx, objectType: "anonymization_request", objectId: requestId });
  return runService(ctx, opts, async (tx) => {
    const rows = await tx.select().from(anonymizationRequests).where(eq(anonymizationRequests.id, requestId)).limit(1);
    const row = rows[0];
    if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Permintaan tidak ditemukan.");
    if (row.status !== "deferred") throw new ConflictError("NOT_DEFERRED", "Hanya permintaan berstatus ditunda yang dapat diajukan ulang.");
    const subject = await subjectInfo(tx, ctx, row.subjectType as "customer" | "employee", row.subjectId);
    const result = await submitOrDefer(tx, ctx, row, subject.name);
    await auditRecord(tx, { ctx, objectType: "anonymization_request", objectId: row.id, action: "submit", after: { status: result.request.status } });
    return result;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Eksekusi (setelah disetujui pemilik)
// ---------------------------------------------------------------------------------------------------------------------

export type AnonymizationOutcome = { executed: boolean; deferred?: string; touched?: Record<string, number> };

/** Anonimkan pelanggan pada seluruh objek; catatan keuangan tetap (tanpa identitas). */
async function anonymizeCustomer(tx: Tx, customerId: string, now: Date): Promise<Record<string, number>> {
  const short = customerId.slice(-6).toUpperCase();
  // Identitas aplikasi pelanggan (P2) dibaca SEBELUM disamarkan: nomor WA pelanggan & akun aplikasinya.
  const [before] = await tx.select({ waPhone: customers.waPhone }).from(customers).where(eq(customers.id, customerId)).limit(1);
  const appAccounts = await tx.select({ id: customerAccounts.id, phone: customerAccounts.phone }).from(customerAccounts).where(eq(customerAccounts.customerId, customerId));
  const c = await tx
    .update(customers)
    .set({ name: `Pelanggan anonim ${short}`, waPhone: "0", contactName: null, notes: null, anonymizedAt: now, updatedAt: now })
    .where(eq(customers.id, customerId))
    .returning({ id: customers.id });
  const a = await tx
    .update(customerAddresses)
    .set({ label: "Dianonimkan", addressText: "Alamat dianonimkan (UU PDP)", lat: null, lng: null, proposedLat: null, proposedLng: null, notes: null, updatedAt: now })
    .where(eq(customerAddresses.customerId, customerId))
    .returning({ id: customerAddresses.id });
  const t = await tx
    .update(trips)
    .set({ recipientName: null, departedLat: null, departedLng: null, arrivedLat: null, arrivedLng: null, completedLat: null, completedLng: null, failLat: null, failLng: null })
    .where(eq(trips.customerId, customerId))
    .returning({ id: trips.id });
  const w = await tx
    .update(waMessageLogs)
    .set({ toPhone: "0", renderedText: "[dianonimkan]", updatedAt: now })
    .where(eq(waMessageLogs.customerId, customerId))
    .returning({ id: waMessageLogs.id });
  const accounts = await tx.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.customerId, customerId));
  for (const acc of accounts) {
    await tx
      .update(customerAccounts)
      .set({ phone: `anon-${acc.id}`, displayName: null, anonymizedAt: now, deactivatedAt: now, updatedAt: now })
      .where(eq(customerAccounts.id, acc.id));
  }
  const app = await anonymizeCustomerAppData(tx, {
    customerId,
    accountIds: appAccounts.map((x) => x.id),
    phones: [before?.waPhone ?? null, ...appAccounts.map((x) => x.phone)],
    now,
  });
  return { customers: c.length, addresses: a.length, trips: t.length, waMessages: w.length + app.waMessages, customerAccounts: accounts.length, ...app.touched };
}

/**
 * Data aplikasi pelanggan (P2) yang memuat nomor WA/identitas (NFR-12, US-M10-06 KP-2, US-P2-01 KP-5): kode OTP
 * (tabel teknis → dihapus), permintaan ganti nomor (nomor lama & baru), catatan permintaan akun (nama/nomor isian),
 * sesi (IP & peramban; dicabut), dan log WA ke nomor itu — termasuk log OTP yang tidak bertanda pelanggan.
 */
async function anonymizeCustomerAppData(
  tx: Tx,
  input: { customerId: string; accountIds: string[]; phones: (string | null)[]; now: Date },
): Promise<{ waMessages: number; touched: Record<string, number> }> {
  const { accountIds, now } = input;
  const phoneSet = new Set(input.phones.filter((p): p is string => !!p && p !== "0" && !p.startsWith("anon-")));
  if (accountIds.length) {
    const changes = await tx.select({ oldPhone: phoneChangeRequests.oldPhone, newPhone: phoneChangeRequests.newPhone }).from(phoneChangeRequests).where(inArray(phoneChangeRequests.customerAccountId, accountIds));
    for (const ch of changes) for (const p of [ch.oldPhone, ch.newPhone]) if (p && p !== "0") phoneSet.add(p);
  }
  const phones = [...phoneSet];
  const otp = accountIds.length || phones.length
    ? await tx
        .delete(otpCodes)
        .where(or(accountIds.length ? inArray(otpCodes.customerAccountId, accountIds) : sql`false`, phones.length ? inArray(otpCodes.phone, phones) : sql`false`))
        .returning({ id: otpCodes.id })
    : [];
  const changes = accountIds.length
    ? await tx.update(phoneChangeRequests).set({ oldPhone: "0", newPhone: "0" }).where(inArray(phoneChangeRequests.customerAccountId, accountIds)).returning({ id: phoneChangeRequests.id })
    : [];
  const requests = await tx
    .update(customerAccountRequests)
    .set({ detail: null, updatedAt: now })
    .where(or(eq(customerAccountRequests.candidateCustomerId, input.customerId), accountIds.length ? inArray(customerAccountRequests.customerAccountId, accountIds) : sql`false`))
    .returning({ id: customerAccountRequests.id });
  const sessions = accountIds.length
    ? await tx
        .update(customerSessions)
        .set({ ip: null, userAgent: null, revokedAt: sql`coalesce(${customerSessions.revokedAt}, ${now})` })
        .where(inArray(customerSessions.customerAccountId, accountIds))
        .returning({ id: customerSessions.id })
    : [];
  const wa = phones.length
    ? await tx.update(waMessageLogs).set({ toPhone: "0", renderedText: "[dianonimkan]", updatedAt: now }).where(inArray(waMessageLogs.toPhone, phones)).returning({ id: waMessageLogs.id })
    : [];
  return { waMessages: wa.length, touched: { otpCodes: otp.length, phoneChanges: changes.length, accountRequests: requests.length, appSessions: sessions.length } };
}

/** Anonimkan karyawan (setelah keluar): nama, panggilan, telepon, lokasi tugas. Akun tetap nonaktif; transaksi tetap. */
async function anonymizeEmployee(tx: Tx, employeeId: string, now: Date): Promise<Record<string, number>> {
  const rows = await tx.select({ no: employees.employeeNo }).from(employees).where(eq(employees.id, employeeId)).limit(1);
  const e = await tx
    .update(employees)
    .set({ fullName: `Karyawan anonim ${rows[0]?.no ?? employeeId.slice(-6)}`, nickname: null, phone: null, workLocation: null, anonymizedAt: now, updatedAt: now })
    .where(eq(employees.id, employeeId))
    .returning({ id: employees.id });
  const u = await tx
    .update(users)
    .set({ pinHash: null, totpSecretEnc: null, totpEnabled: false, passwordHash: null, updatedAt: now })
    .where(and(eq(users.employeeId, employeeId), eq(users.status, "inactive")))
    .returning({ id: users.id });
  return { employees: e.length, credentialsCleared: u.length };
}

/** Jalankan anonimisasi (dipanggil handler persetujuan dengan konteks penyetuju). */
export async function executeAnonymization(tx: Tx, ctx: ActorContext, row: AnonymizationRow): Promise<AnonymizationOutcome> {
  if (row.subjectType === "customer") {
    const open = await openReceivableOf(tx, row.subjectId);
    if (open.count > 0) {
      const why = `Piutang terbuka ${formatRupiah(open.amount)} (${open.count} faktur) saat dijalankan. Anonimisasi ditunda sampai lunas atau dihapuskan (PTB-36).`;
      await tx.update(anonymizationRequests).set({ status: "deferred", blockedReason: why, updatedAt: ctx.now }).where(eq(anonymizationRequests.id, row.id));
      await auditRecord(tx, { ctx, objectType: "anonymization_request", objectId: row.id, action: "update", after: { status: "deferred" }, reason: why, rule: "PTB-36" });
      await notify(tx, {
        event: "anonymization.deferred",
        tenantId: row.tenantId,
        recipients: row.createdBy ? { userIds: [row.createdBy] } : undefined,
        title: "Anonimisasi ditunda: piutang terbuka",
        body: `${why} Beri tahu pemohon.`,
        objectType: "anonymization_request",
        objectId: row.id,
        link: "/akses/data-pribadi",
        now: ctx.now,
      });
      return { executed: false, deferred: why };
    }
  } else if (row.subjectType !== "employee") {
    throw new DomainError("SUBJECT_UNSUPPORTED", "Jenis subjek ini dianonimkan oleh modul aplikasi pelanggan.");
  }
  const touched = row.subjectType === "customer" ? await anonymizeCustomer(tx, row.subjectId, ctx.now) : await anonymizeEmployee(tx, row.subjectId, ctx.now);
  await tx
    .update(anonymizationRequests)
    .set({ status: "executed", executedAt: ctx.now, executedBy: ctx.userId, blockedReason: null, updatedAt: ctx.now })
    .where(eq(anonymizationRequests.id, row.id));
  await auditRecord(tx, {
    ctx,
    objectType: row.subjectType,
    objectId: row.subjectId,
    action: "anonymize",
    after: { anonymized: true, touched, request: row.id },
    reason: row.reason,
    rule: "US-M10-06 KP-2",
  });
  await auditRecord(tx, { ctx, objectType: "anonymization_request", objectId: row.id, action: "update", before: { status: row.status }, after: { status: "executed", touched } });
  await notify(tx, {
    event: "anonymization.executed",
    tenantId: row.tenantId,
    title: `Anonimisasi ${row.subjectType === "customer" ? "pelanggan" : "karyawan"} dijalankan`,
    body: `Nama, kontak, alamat, dan koordinat dihapus dari ${Object.values(touched).reduce((a, b) => a + b, 0)} catatan; catatan keuangan tetap.`,
    objectType: "anonymization_request",
    objectId: row.id,
    link: "/akses/data-pribadi",
    now: ctx.now,
  });
  return { executed: true, touched };
}

async function loadByApproval(tx: Tx, objectId: string): Promise<AnonymizationRow | null> {
  const rows = await tx.select().from(anonymizationRequests).where(eq(anonymizationRequests.id, objectId)).limit(1);
  return rows[0] ?? null;
}

export const anonymizationHandlers: ApprovalHandlers = {
  onApproved: async ({ tx, request, ctx }) => {
    const row = await loadByApproval(tx, request.objectId);
    if (!row) return { executed: false, note: "Permintaan anonimisasi tidak ditemukan" };
    await tx.update(anonymizationRequests).set({ status: "approved", updatedAt: ctx.now }).where(eq(anonymizationRequests.id, row.id));
    return executeAnonymization(tx, ctx, { ...row, status: "approved" });
  },
  onRejected: async ({ tx, request, ctx, reason }) => {
    const row = await loadByApproval(tx, request.objectId);
    if (row) await tx.update(anonymizationRequests).set({ status: "rejected", blockedReason: reason, updatedAt: ctx.now }).where(eq(anonymizationRequests.id, row.id));
  },
  onCancelled: async ({ tx, request, ctx, reason }) => {
    const row = await loadByApproval(tx, request.objectId);
    if (row) await tx.update(anonymizationRequests).set({ status: "rejected", blockedReason: reason ?? "Dibatalkan", updatedAt: ctx.now }).where(eq(anonymizationRequests.id, row.id));
  },
};

/** Daftar permintaan anonimisasi tenant (pemilik, admin sistem). */
export async function listAnonymizationRequests(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.personal_data.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx.select().from(anonymizationRequests).where(eq(anonymizationRequests.tenantId, ctx.tenantId)).orderBy(desc(anonymizationRequests.createdAt)).limit(200);
  const custIds = rows.filter((r) => r.subjectType === "customer").map((r) => r.subjectId);
  const empIds = rows.filter((r) => r.subjectType === "employee").map((r) => r.subjectId);
  const cust = custIds.length ? await tx.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, custIds)) : [];
  const emp = empIds.length ? await tx.select({ id: employees.id, name: employees.fullName }).from(employees).where(inArray(employees.id, empIds)) : [];
  const names = await userNames(tx, rows.flatMap((r) => [r.createdBy, r.executedBy]));
  return rows.map((r) => ({
    ...r,
    subjectName: (r.subjectType === "customer" ? cust : emp).find((x) => x.id === r.subjectId)?.name ?? "—",
    requestedByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
    executedByName: r.executedBy ? (names.get(r.executedBy) ?? null) : null,
  }));
}

/** Job harian: permintaan ditunda yang piutangnya kini lunas → beri tahu admin sistem agar diajukan ulang. */
export async function remindDeferredAnonymizations(now: Date = new Date(), db?: Db): Promise<{ ready: number }> {
  return withTx(
    async (tx) => {
      const deferred = await tx.select().from(anonymizationRequests).where(eq(anonymizationRequests.status, "deferred"));
      let ready = 0;
      for (const r of deferred) {
        if (r.subjectType !== "customer") continue;
        const open = await openReceivableOf(tx, r.subjectId);
        if (open.count > 0) continue;
        ready++;
        await notify(tx, {
          event: "anonymization.deferred",
          tenantId: r.tenantId,
          recipients: r.createdBy ? { userIds: [r.createdBy] } : undefined,
          title: "Piutang lunas: permintaan anonimisasi dapat diajukan ulang",
          body: "Pelanggan tidak lagi memiliki piutang terbuka. Ajukan ulang permintaan di halaman Data pribadi.",
          objectType: "anonymization_request",
          objectId: r.id,
          groupKey: `anonymization.ready:${r.id}`,
          link: "/akses/data-pribadi",
          now,
        });
      }
      return { ready };
    },
    { db },
  );
}

/** Pelanggan yang dapat dipilih pada formulir permintaan (nama saja — tanpa kontak). */
export async function searchSubjects(ctx: ActorContext, type: "customer" | "employee", q: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.personal_data.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const term = `%${q.trim().toLowerCase()}%`;
  if (type === "customer") {
    return tx
      .select({ id: customers.id, name: customers.name, code: customers.code })
      .from(customers)
      .where(and(eq(customers.tenantId, ctx.tenantId), sql`${customers.anonymizedAt} is null`, sql`lower(${customers.name}) like ${term}`))
      .limit(20);
  }
  return tx
    .select({ id: employees.id, name: employees.fullName, code: employees.employeeNo })
    .from(employees)
    .where(and(eq(employees.tenantId, ctx.tenantId), sql`${employees.anonymizedAt} is null`, sql`lower(${employees.fullName}) like ${term}`))
    .limit(20);
}

/** Pilihan subjek formulir: pelanggan belum dianonimkan (nama saja) & karyawan yang sudah keluar/nonaktif. */
export async function anonymizationCandidates(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.personal_data.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const cust = await tx
    .select({ id: customers.id, name: customers.name, code: customers.code })
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), sql`${customers.anonymizedAt} is null`, sql`${customers.internalOutletId} is null`))
    .orderBy(customers.name)
    .limit(300);
  const emp = await tx
    .select({ id: employees.id, name: employees.fullName, code: employees.employeeNo, isActive: employees.isActive, exitDate: employees.exitDate })
    .from(employees)
    .where(and(eq(employees.tenantId, ctx.tenantId), sql`${employees.anonymizedAt} is null`))
    .orderBy(employees.fullName);
  return {
    customers: cust.map((c) => ({ value: `customer:${c.id}`, label: `${c.name}${c.code ? ` (${c.code})` : ""}` })),
    employees: emp.filter((e) => !e.isActive || (e.exitDate && e.exitDate <= today)).map((e) => ({ value: `employee:${e.id}`, label: `${e.name} (${e.code})` })),
  };
}
