/**
 * P2 — akun pelanggan (US-P2-01 KP-2/KP-4/KP-5; 8.3, 8.7).
 *
 * Alur: OTP benar → akun "Terverifikasi WA" → lengkapi pendaftaran (persetujuan UU PDP + nama):
 * - nomor cocok pelanggan M1 DAN nama cocok (≥ `name_match_min_pct`) → tertaut ke pelanggan itu (nama, alamat, status
 *   kredit, harga khusus ikut, karena memang data M1 yang sama);
 * - nomor cocok tetapi nama TIDAK cocok (nomor berganti pemilik, 8.7) → TIDAK ditautkan; menunggu verifikasi
 *   Dispatcher (`customer_account_requests` kind `review` + notifikasi);
 * - nomor baru → pelanggan M1 baru berstatus Tunai (BR-01), segmen rumah tangga (dapat diubah Dispatcher di M1).
 * Satu nomor satu akun (unik DB). Hapus akun = nonaktif + permintaan anonimisasi lewat M10 (US-M10-06 KP-2).
 */
import "server-only";

import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { customerAccountRequests, customerAccounts, customers } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, runInTx, type Tx } from "@/server/core/db";
import { ConflictError, DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import * as flags from "@/server/core/flags";
import { notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";
import { normalizeWaNumber } from "@/server/core/wa";
import * as m1 from "@/server/modules/m1-master";

import { addressInputSchema, applyCustomerPin, type CustomerAddressInput } from "./addresses";
import { revokeAccountSessions, verifyNewPhone, type PhoneChange } from "./auth";
import { appRules, assertAppEnabled, customerBusinessDate, maskPhone, recordCustomerAudit, sysCtx, type AccountRow, type CustomerContext } from "./common";
import { notifyCustomer } from "./messaging";

// =====================================================================================================================
// Kemiripan nama (US-P2-01 KP-2)
// =====================================================================================================================

const HONORIFICS = new Set(["bapak", "bpk", "pak", "ibu", "bu", "sdr", "sdri", "saudara", "saudari", "h", "hj", "haji", "hajah", "tn", "ny", "nn"]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !HONORIFICS.has(t));
}

/** Kemiripan nama 0–100: porsi token nama yang lebih pendek yang cocok (sama / awalan ≥ 3 huruf) di nama lain. */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set<number>();
  let hits = 0;
  for (const t of short) {
    const idx = long.findIndex((u, i) => !used.has(i) && (u === t || (t.length >= 3 && u.length >= 3 && (u.startsWith(t) || t.startsWith(u)))));
    if (idx >= 0) {
      used.add(idx);
      hits++;
    }
  }
  return Math.round((hits / short.length) * 100);
}

// =====================================================================================================================
// Pendaftaran
// =====================================================================================================================

const completeSchema = z.object({
  name: z.string({ error: "Nama wajib diisi." }).trim().min(2, { error: "Nama wajib diisi (minimal 2 huruf)." }).max(150),
  consent: z.literal(true, { error: "Centang persetujuan penggunaan data pribadi untuk melanjutkan." }),
  address: addressInputSchema.nullable().optional(),
});

export type CompleteRegistrationInput = { name: string; consent: boolean; address?: CustomerAddressInput | null };

export type CompleteRegistrationResult =
  | { status: "linked"; customerId: string; customerName: string; newCustomer: boolean }
  | { status: "pending_review"; requestId: string }
  | { status: "address_required" };

/**
 * Lengkapi pendaftaran (US-P2-01 KP-2/KP-5): persetujuan UU PDP + nama; tautkan ke pelanggan M1 bila nomor & nama
 * cocok, menunggu verifikasi Dispatcher bila nama tidak cocok, atau buat pelanggan baru Tunai rumah tangga.
 */
export async function completeRegistration(cctx: CustomerContext, input: CompleteRegistrationInput, opts: { tx?: Tx } = {}): Promise<CompleteRegistrationResult> {
  const data = parseInput(completeSchema, input, { name: "Nama", consent: "Persetujuan", address: "Alamat" });
  return runInTx(opts.tx, async (tx) => {
    await assertAppEnabled(tx, cctx.tenantId);
    const [account] = await tx.select().from(customerAccounts).where(eq(customerAccounts.id, cctx.accountId)).limit(1).for("update");
    if (!account) throw new NotFoundError("Akun tidak ditemukan.");
    if (account.status === "linked") return { status: "linked", customerId: account.customerId!, customerName: account.displayName ?? data.name, newCustomer: false };
    if (account.status === "pending_review") {
      const req = await openRequest(tx, account.id, "review");
      return { status: "pending_review", requestId: req?.id ?? "" };
    }
    const date = customerBusinessDate(cctx);
    const rules = await appRules(tx, date, cctx.tenantId);
    const candidates = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, cctx.tenantId), eq(customers.waPhone, account.phone), eq(customers.isActive, true), isNull(customers.anonymizedAt)));
    const consent = { consentPdpAt: cctx.now, consentVersion: rules.consent_version, displayName: data.name, updatedAt: cctx.now };

    if (candidates.length) {
      const scored = candidates.map((c) => ({ c, score: nameSimilarity(data.name, c.name) })).sort((a, b) => b.score - a.score);
      const best = scored[0]!;
      if (best.score >= rules.name_match_min_pct) {
        await tx.update(customerAccounts).set({ ...consent, customerId: best.c.id, status: "linked", linkedAt: cctx.now }).where(eq(customerAccounts.id, account.id));
        await recordCustomerAudit(tx, cctx, {
          objectType: "customer_account",
          objectId: account.id,
          action: "link",
          before: { status: account.status },
          after: { status: "linked", customerId: best.c.id, nameSimilarity: best.score, consentVersion: rules.consent_version },
          rule: "US-P2-01 KP-2/KP-5",
        });
        return { status: "linked", customerId: best.c.id, customerName: best.c.name, newCustomer: false };
      }
      // 8.7: nomor lama dipakai orang lain → tidak ditautkan otomatis.
      await tx.update(customerAccounts).set({ ...consent, status: "pending_review" }).where(eq(customerAccounts.id, account.id));
      const [req] = await tx
        .insert(customerAccountRequests)
        .values({ tenantId: cctx.tenantId, customerAccountId: account.id, kind: "review", reason: "Nama tidak cocok dengan pelanggan yang memakai nomor WA ini (8.7).", detail: data.name, candidateCustomerId: best.c.id, createdAt: cctx.now, updatedAt: cctx.now })
        .returning({ id: customerAccountRequests.id });
      await recordCustomerAudit(tx, cctx, {
        objectType: "customer_account",
        objectId: account.id,
        action: "review_requested",
        before: { status: account.status },
        after: { status: "pending_review", candidateCustomerId: best.c.id, nameSimilarity: best.score, consentVersion: rules.consent_version },
        rule: "US-P2-01 KP-2, 8.7",
      });
      await notify(tx, {
        event: "customer_app.account_review",
        tenantId: cctx.tenantId,
        title: `Verifikasi akun aplikasi: ${data.name} (${maskPhone(account.phone)})`,
        body: `Nama yang diisi tidak cocok dengan pelanggan ${best.c.name} yang memakai nomor ini. Hubungi pelanggan lalu tautkan atau buat pelanggan baru.`,
        objectType: "customer_account",
        objectId: account.id,
        link: "/keluhan/akun",
        now: cctx.now,
      });
      return { status: "pending_review", requestId: req!.id };
    }

    // Nomor baru → pelanggan M1 baru (Tunai, rumah tangga; BR-01).
    if (!data.address) return { status: "address_required" };
    const created = await m1.createCustomer(
      sysCtx(cctx.tenantId, cctx.now),
      {
        name: data.name,
        segment: "household",
        waPhone: account.phone,
        addresses: [{ label: data.address.label, addressText: data.address.addressText, notes: data.address.notes ?? null }],
        confirmDuplicate: true,
        duplicateNote: "Daftar mandiri lewat aplikasi pelanggan (nomor WA terverifikasi OTP).",
        notes: "Didaftarkan lewat aplikasi pelanggan.",
      },
      { tx },
    );
    if (created.status !== "created") throw new DomainError("CUSTOMER_CREATE_FAILED", "Pendaftaran gagal dibuat. Coba lagi atau hubungi kantor EQUA.");
    await applyCustomerPin(tx, { addressId: created.addresses[0]!.id, tenantId: cctx.tenantId, lat: data.address.lat, lng: data.address.lng, now: cctx.now, accountId: account.id });
    await tx.update(customerAccounts).set({ ...consent, customerId: created.customer.id, status: "linked", linkedAt: cctx.now }).where(eq(customerAccounts.id, account.id));
    await recordCustomerAudit(tx, cctx, {
      objectType: "customer_account",
      objectId: account.id,
      action: "link",
      before: { status: account.status },
      after: { status: "linked", customerId: created.customer.id, newCustomer: true, creditStatus: created.customer.creditStatus, segment: created.customer.segment, consentVersion: rules.consent_version },
      rule: "US-P2-01 KP-2 (BR-01)",
    });
    return { status: "linked", customerId: created.customer.id, customerName: created.customer.name, newCustomer: true };
  });
}

async function openRequest(tx: Tx, accountId: string, kind: string) {
  return (
    (
      await tx
        .select()
        .from(customerAccountRequests)
        .where(and(eq(customerAccountRequests.customerAccountId, accountId), eq(customerAccountRequests.kind, kind), eq(customerAccountRequests.status, "open")))
        .orderBy(desc(customerAccountRequests.createdAt))
        .limit(1)
    )[0] ?? null
  );
}

export type CustomerProfile = {
  accountId: string;
  phone: string;
  displayName: string | null;
  status: EnumValue<"customer_account_status">;
  statusLabel: string;
  consentAt: Date | null;
  consentVersion: string | null;
  customer: { id: string; name: string; segment: string; creditStatus: string; creditStatusLabel: string } | null;
};

export async function getMyProfile(cctx: CustomerContext, opts: { tx?: Tx } = {}): Promise<CustomerProfile> {
  const tx = opts.tx ?? getDb();
  const [a] = await tx.select().from(customerAccounts).where(eq(customerAccounts.id, cctx.accountId)).limit(1);
  if (!a) throw new NotFoundError("Akun tidak ditemukan.");
  const c = a.customerId && a.status === "linked" ? (await tx.select().from(customers).where(eq(customers.id, a.customerId)).limit(1))[0] : null;
  return {
    accountId: a.id,
    phone: a.phone,
    displayName: a.displayName,
    status: a.status,
    statusLabel: label("customer_account_status", a.status),
    consentAt: a.consentPdpAt,
    consentVersion: a.consentVersion,
    customer: c
      ? { id: c.id, name: c.name, segment: label("customer_segment", c.segment), creditStatus: c.creditStatus, creditStatusLabel: label("credit_status", c.creditStatus) }
      : null,
  };
}

/** Langkah terakhir ganti nomor (US-P2-01 KP-4): nomor akun & nomor WA pelanggan M1 diganti. */
export async function completePhoneChange(cctx: CustomerContext, input: { code: string }, opts: { tx?: Tx } = {}): Promise<PhoneChange> {
  return verifyNewPhone(
    cctx,
    input,
    async (tx, change) => {
      if (cctx.customerId) {
        const res = await m1.updateCustomer(
          sysCtx(cctx.tenantId, cctx.now),
          cctx.customerId,
          { waPhone: change.newPhone, confirmDuplicate: true, correctionReason: "Ganti nomor WA lewat aplikasi pelanggan (OTP nomor lama & baru)" },
          { tx },
        );
        if (res.status !== "updated") throw new DomainError("PHONE_UPDATE_FAILED", "Nomor WA pelanggan gagal diperbarui. Hubungi kantor EQUA.");
      }
      await recordCustomerAudit(tx, cctx, {
        objectType: "customer_account",
        objectId: cctx.accountId,
        action: "phone_changed",
        before: { phone: maskPhone(change.oldPhone) },
        after: { phone: maskPhone(change.newPhone) },
        rule: "US-P2-01 KP-4",
      });
    },
    opts,
  );
}

/**
 * Hapus akun (US-P2-01 KP-5): akun dinonaktifkan & semua sesi dicabut seketika; permintaan anonimisasi diteruskan ke
 * admin sistem (US-M10-06 KP-2: admin sistem mencatat, pemilik menyetujui; tertunda bila masih ada piutang).
 */
export async function requestAccountDeletion(cctx: CustomerContext, input: { reason?: string | null; confirm: string }, opts: { tx?: Tx } = {}) {
  const data = parseInput(
    z.object({ reason: z.string().trim().max(300).nullable().optional(), confirm: z.string().trim().toUpperCase().refine((v) => v === "HAPUS", { error: "Ketik HAPUS untuk mengonfirmasi." }) }),
    input,
    { reason: "Alasan", confirm: "Konfirmasi" },
  );
  return runInTx(opts.tx, async (tx) => {
    await tx.update(customerAccounts).set({ status: "inactive", deactivatedAt: cctx.now, updatedAt: cctx.now }).where(eq(customerAccounts.id, cctx.accountId));
    const revoked = await revokeAccountSessions(tx, cctx.accountId, cctx.now);
    const [req] = await tx
      .insert(customerAccountRequests)
      .values({ tenantId: cctx.tenantId, customerAccountId: cctx.accountId, kind: "deletion", reason: data.reason || "Pelanggan meminta hapus akun lewat aplikasi.", candidateCustomerId: cctx.customerId, createdAt: cctx.now, updatedAt: cctx.now })
      .returning({ id: customerAccountRequests.id });
    await recordCustomerAudit(tx, cctx, { objectType: "customer_account", objectId: cctx.accountId, action: "deactivate", after: { status: "inactive", sessionsRevoked: revoked, deletionRequestId: req!.id }, reason: data.reason ?? null, rule: "US-P2-01 KP-5, US-M10-06 KP-2" });
    await notify(tx, {
      event: "customer_app.deletion_requested",
      tenantId: cctx.tenantId,
      title: `Pelanggan meminta hapus akun aplikasi (${maskPhone(cctx.phone)})`,
      body: "Catat permintaan anonimisasi data pribadi pelanggan ini di Akses > Data pribadi; pemilik menyetujui. Pelanggan berpiutang ditunda sampai lunas (PTB-36).",
      objectType: "customer_account",
      objectId: cctx.accountId,
      link: "/akses/data-pribadi",
      now: cctx.now,
    });
    return { requestId: req!.id, sessionsRevoked: revoked };
  });
}

// =====================================================================================================================
// Kantor: akun pelanggan (/keluhan/akun)
// =====================================================================================================================

export type AccountListRow = {
  id: string;
  phone: string;
  displayName: string | null;
  status: EnumValue<"customer_account_status">;
  customerId: string | null;
  customerName: string | null;
  customerCode: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  consentAt: Date | null;
};

/** Daftar akun aplikasi (Pemilik, Dispatcher). */
export async function listAccounts(ctx: ActorContext, filter: { status?: string | null; q?: string | null; limit?: number } = {}, opts: { tx?: Tx } = {}): Promise<AccountListRow[]> {
  await authorize(ctx, "p2.customer_account.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds: SQL[] = [eq(customerAccounts.tenantId, ctx.tenantId)];
  if (filter.status) conds.push(sql`${customerAccounts.status} = ${filter.status}`);
  if (filter.q && filter.q.trim().length >= 2) {
    const q = `%${filter.q.trim()}%`;
    const phone = normalizeWaNumber(filter.q);
    conds.push(or(ilike(customerAccounts.displayName, q), ilike(customers.name, q), ilike(customers.code, q), phone ? eq(customerAccounts.phone, phone) : ilike(customerAccounts.phone, q))!);
  }
  const rows = await tx
    .select({ a: customerAccounts, customerName: customers.name, customerCode: customers.code })
    .from(customerAccounts)
    .leftJoin(customers, eq(customers.id, customerAccounts.customerId))
    .where(and(...conds))
    .orderBy(desc(customerAccounts.createdAt))
    .limit(filter.limit ?? 500);
  return rows.map((r) => ({
    id: r.a.id,
    phone: r.a.phone,
    displayName: r.a.displayName,
    status: r.a.status,
    customerId: r.a.customerId,
    customerName: r.customerName,
    customerCode: r.customerCode,
    createdAt: r.a.createdAt,
    lastLoginAt: r.a.lastLoginAt,
    consentAt: r.a.consentPdpAt,
  }));
}

export type AccountRequestRow = {
  id: string;
  kind: string;
  status: string;
  reason: string | null;
  detail: string | null;
  createdAt: Date;
  handledAt: Date | null;
  handledNote: string | null;
  account: { id: string; phone: string; displayName: string | null; status: string; anonymizedAt: Date | null };
  candidate: { id: string; name: string; code: string | null } | null;
};

/** Permintaan akun (verifikasi nama, hapus akun, ganti nomor). */
export async function listAccountRequests(ctx: ActorContext, filter: { status?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<AccountRequestRow[]> {
  await authorize(ctx, "p2.customer_account.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const conds: SQL[] = [eq(customerAccountRequests.tenantId, ctx.tenantId)];
  if (filter.status) conds.push(eq(customerAccountRequests.status, filter.status));
  const rows = await tx
    .select({ r: customerAccountRequests, a: customerAccounts, cName: customers.name, cCode: customers.code, cId: customers.id })
    .from(customerAccountRequests)
    .innerJoin(customerAccounts, eq(customerAccounts.id, customerAccountRequests.customerAccountId))
    .leftJoin(customers, eq(customers.id, customerAccountRequests.candidateCustomerId))
    .where(and(...conds))
    .orderBy(desc(customerAccountRequests.createdAt))
    .limit(300);
  return rows.map((x) => ({
    id: x.r.id,
    kind: x.r.kind,
    status: x.r.kind === "deletion" && x.a.anonymizedAt ? "done" : x.r.status,
    reason: x.r.reason,
    detail: x.r.detail,
    createdAt: x.r.createdAt,
    handledAt: x.r.handledAt,
    handledNote: x.r.handledNote,
    account: { id: x.a.id, phone: x.a.phone, displayName: x.a.displayName, status: x.a.status, anonymizedAt: x.a.anonymizedAt },
    candidate: x.cId ? { id: x.cId, name: x.cName!, code: x.cCode } : null,
  }));
}

const verifySchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("link"), requestId: z.uuid(), customerId: z.uuid({ error: "Pilih pelanggan yang ditautkan." }), note: z.string().trim().min(3, { error: "Catatan verifikasi wajib diisi (mis. sudah ditelepon)." }) }),
  z.object({
    decision: z.literal("new_customer"),
    requestId: z.uuid(),
    addressText: z.string().trim().min(5, { error: "Alamat pelanggan baru wajib diisi (minimal 5 karakter)." }),
    note: z.string().trim().min(3, { error: "Catatan verifikasi wajib diisi." }),
  }),
  z.object({ decision: z.literal("reject"), requestId: z.uuid(), note: z.string().trim().min(3, { error: "Alasan penolakan wajib diisi." }) }),
]);

/**
 * Dispatcher memverifikasi akun yang namanya tidak cocok (8.7): tautkan ke pelanggan (setelah konfirmasi telepon),
 * buat pelanggan baru Tunai rumah tangga, atau tolak (akun dinonaktifkan).
 */
export async function verifyAccount(ctx: ActorContext, input: z.input<typeof verifySchema>, opts: { tx?: Tx } = {}): Promise<AccountRow> {
  await authorize(ctx, "p2.customer_account.verify", { tx: opts.tx });
  const data = parseInput(verifySchema, input, { customerId: "Pelanggan", addressText: "Alamat", note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const [req] = await tx.select().from(customerAccountRequests).where(and(eq(customerAccountRequests.id, data.requestId), eq(customerAccountRequests.tenantId, ctx.tenantId))).limit(1).for("update");
    if (!req || req.kind !== "review") throw new NotFoundError("Permintaan verifikasi tidak ditemukan.");
    if (req.status !== "open") throw new ConflictError("REQUEST_HANDLED", "Permintaan ini sudah ditangani.");
    const [account] = await tx.select().from(customerAccounts).where(eq(customerAccounts.id, req.customerAccountId)).limit(1).for("update");
    if (!account) throw new NotFoundError("Akun tidak ditemukan.");
    let patch: Partial<typeof customerAccounts.$inferInsert>;
    let customerId: string | null = null;
    if (data.decision === "link") {
      const [c] = await tx.select().from(customers).where(and(eq(customers.id, data.customerId), eq(customers.tenantId, ctx.tenantId))).limit(1);
      if (!c || !c.isActive) throw ValidationError.field("customerId", "Pelanggan tidak ditemukan atau nonaktif.");
      if (c.waPhone !== account.phone) {
        const res = await m1.updateCustomer(ctx, c.id, { waPhone: account.phone, confirmDuplicate: true, correctionReason: `Nomor WA diverifikasi dari aplikasi pelanggan: ${data.note}` }, { tx });
        if (res.status !== "updated") throw new DomainError("PHONE_UPDATE_FAILED", "Nomor WA pelanggan gagal diperbarui.");
      }
      customerId = c.id;
      patch = { status: "linked", customerId: c.id, linkedAt: ctx.now, linkedBy: ctx.userId };
    } else if (data.decision === "new_customer") {
      const created = await m1.createCustomer(
        ctx,
        { name: account.displayName ?? "Pelanggan aplikasi", segment: "household", waPhone: account.phone, addresses: [{ label: "Utama", addressText: data.addressText }], confirmDuplicate: true, duplicateNote: `Akun aplikasi (nomor berganti pemilik): ${data.note}` },
        { tx },
      );
      if (created.status !== "created") throw new DomainError("CUSTOMER_CREATE_FAILED", "Pelanggan baru gagal dibuat.");
      customerId = created.customer.id;
      patch = { status: "linked", customerId, linkedAt: ctx.now, linkedBy: ctx.userId };
    } else {
      patch = { status: "inactive", deactivatedAt: ctx.now };
      await revokeAccountSessions(tx, account.id, ctx.now);
    }
    const [after] = await tx.update(customerAccounts).set({ ...patch, updatedAt: ctx.now }).where(eq(customerAccounts.id, account.id)).returning();
    await tx
      .update(customerAccountRequests)
      .set({ status: data.decision === "reject" ? "rejected" : "done", handledAt: ctx.now, handledBy: ctx.userId, handledNote: data.note, updatedAt: ctx.now })
      .where(eq(customerAccountRequests.id, req.id));
    await auditRecord(tx, { ctx, objectType: "customer_account", objectId: account.id, action: data.decision === "reject" ? "reject" : "link", before: { status: account.status, customerId: account.customerId }, after: { status: after!.status, customerId: after!.customerId }, reason: data.note, rule: "US-P2-01 KP-2, 8.7" });
    if (customerId) {
      await notifyCustomer(tx, {
        tenantId: ctx.tenantId,
        customerId,
        accountId: account.id,
        kind: "account_verified",
        title: "Akun Anda sudah diverifikasi",
        body: "Akun aplikasi EQUA Anda sudah terhubung. Sekarang Anda dapat memesan air dari aplikasi.",
        link: "/app",
        objectType: "customer_account",
        objectId: account.id,
        dedupeKey: `account_verified:${account.id}`,
        now: ctx.now,
      });
    }
    return after!;
  });
}

/** Ganti nomor lewat Dispatcher (US-P2-01 KP-4): akun & nomor WA pelanggan M1 diganti, sesi dicabut. */
export async function officeChangePhone(ctx: ActorContext, input: { accountId: string; newPhone: string; reason: string }, opts: { tx?: Tx } = {}): Promise<AccountRow> {
  await authorize(ctx, "p2.customer_account.verify", { tx: opts.tx });
  const data = parseInput(
    z.object({
      accountId: z.uuid(),
      newPhone: z.string().trim().transform((v, c) => normalizeWaNumber(v) ?? (c.addIssue({ code: "custom", message: "Nomor WhatsApp tidak valid." }), z.NEVER)),
      reason: z.string().trim().min(5, { error: "Alasan ganti nomor wajib diisi (minimal 5 karakter)." }),
    }),
    input,
    { newPhone: "Nomor WhatsApp baru", reason: "Alasan" },
  );
  return runService(ctx, opts, async (tx) => {
    const [account] = await tx.select().from(customerAccounts).where(and(eq(customerAccounts.id, data.accountId), eq(customerAccounts.tenantId, ctx.tenantId))).limit(1).for("update");
    if (!account) throw new NotFoundError("Akun tidak ditemukan.");
    const [taken] = await tx.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.phone, data.newPhone)).limit(1);
    if (taken) throw new ConflictError("PHONE_IN_USE", "Nomor itu sudah dipakai akun lain (satu nomor satu akun).");
    const [after] = await tx.update(customerAccounts).set({ phone: data.newPhone, updatedAt: ctx.now }).where(eq(customerAccounts.id, account.id)).returning();
    if (account.customerId) {
      const res = await m1.updateCustomer(ctx, account.customerId, { waPhone: data.newPhone, confirmDuplicate: true, correctionReason: `Ganti nomor WA lewat Dispatcher: ${data.reason}` }, { tx });
      if (res.status !== "updated") throw new DomainError("PHONE_UPDATE_FAILED", "Nomor WA pelanggan gagal diperbarui.");
    }
    await revokeAccountSessions(tx, account.id, ctx.now);
    await tx.insert(customerAccountRequests).values({
      tenantId: ctx.tenantId,
      customerAccountId: account.id,
      kind: "phone_change",
      status: "done",
      reason: data.reason,
      detail: maskPhone(data.newPhone),
      handledAt: ctx.now,
      handledBy: ctx.userId,
      handledNote: data.reason,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
    await auditRecord(tx, { ctx, objectType: "customer_account", objectId: account.id, action: "phone_changed", before: { phone: maskPhone(account.phone) }, after: { phone: maskPhone(data.newPhone) }, reason: data.reason, rule: "US-P2-01 KP-4" });
    return after!;
  });
}

/** Status aktivasi aplikasi pelanggan (flag `phase2.customer_app`, D-02). */
export async function customerAppStatus(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<{ enabled: boolean }> {
  await authorize(ctx, "p2.customer_account.read", { tx: opts.tx });
  return { enabled: await flags.isEnabled(opts.tx ?? getDb(), "phase2.customer_app", { tenantId: ctx.tenantId }) };
}

/** Pemilik mengaktifkan/menonaktifkan aplikasi pelanggan setelah prasyarat TG-9 (8.1) terpenuhi — alasan wajib. */
export async function setCustomerAppEnabled(ctx: ActorContext, input: { enabled: boolean; reason: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p2.customer_account.read", { tx: opts.tx });
  return flags.set(ctx, "phase2.customer_app", input.enabled, { scope: { type: "tenant", refId: ctx.tenantId }, reason: input.reason }, opts);
}

/** Akun aktif yang tertaut ke pelanggan (dipakai handler event & job). */
export async function linkedAccounts(tx: Tx, customerIds: string[]) {
  if (!customerIds.length) return [];
  return tx
    .select()
    .from(customerAccounts)
    .where(and(inArray(customerAccounts.customerId, customerIds), eq(customerAccounts.status, "linked"), isNull(customerAccounts.deactivatedAt)));
}
