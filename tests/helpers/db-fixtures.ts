/**
 * Pembuat baris uji tingkat DB (tanpa lapisan layanan) untuk uji constraint/trigger `tests/db/**`. Semua fungsi menulis
 * baris nyata di atas DB seed (`createTestDb({ seed: true })`) dan mengembalikan ID-nya. Nomor dokumen dibuat acak unik.
 *
 * ```ts
 * const trip = await createTripFixture(db);
 * const shift = await createShiftFixture(db, { outletCode: "D01", status: "closed" });
 * await expectSqlState(db.update(tripPayments).set({ receivedAmount: 0 }), SQLSTATE_IMMUTABLE);
 * ```
 */
import { expect } from "vitest";

import type { Db, DbOrTx } from "@/db/client";
import { isHardeningViolation } from "@/db/hardening";
import {
  accountingPeriods,
  journalLines,
  journals,
  orders,
  outlets,
  posSaleLines,
  posSales,
  shifts,
  tenants,
  trips,
} from "@/db/schema";
import { accountId, customerId, EQUA_TENANT_ID, outletId, productId, seedId, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";

let seq = 0;
/** Angka unik per proses (untuk nomor dokumen uji). */
export function uniqueSeq(): number {
  seq += 1;
  return Number(`${Date.now() % 100_000}${String(seq).padStart(3, "0")}`) % 1_000_000;
}

/** SQLSTATE dari galat Drizzle/PGlite (galat asli ada di `cause`). */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Gabungan pesan galat berantai (`cause`). */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    if (current instanceof Error) parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

/** SQLSTATE Postgres baku yang sering diuji. */
export const PG = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
} as const;

/**
 * Pastikan operasi ditolak dengan SQLSTATE tertentu (dan opsional memuat potongan pesan). Kode `EQxxx` juga harus
 * dikenali `isHardeningViolation`.
 */
export async function expectSqlState(operation: PromiseLike<unknown>, code: string, messagePart?: string): Promise<unknown> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, `operasi seharusnya ditolak dengan SQLSTATE ${code}`).toBeDefined();
  expect(sqlState(caught), errorText(caught)).toBe(code);
  if (messagePart) expect(errorText(caught)).toContain(messagePart);
  if (code.startsWith("EQ")) expect(isHardeningViolation(caught)).toBe(true);
  return caught;
}

/** Alamat utama pelanggan seed. */
export const seedAddressId = (customerCode: string) => seedId(`address:${customerCode}:utama`);

export type TripFixture = { orderId: string; tripId: string; orderNumber: string; tripNumber: string; customerId: string };

/** Pesanan + satu rit (tunai, Rp 200.000) untuk pelanggan seed (bawaan PLG-0034 — hotel tempo). */
export async function createTripFixture(
  db: DbOrTx,
  opts: { customerCode?: string; recurringOrderId?: string; requestedDate?: string; tripDate?: string } = {},
): Promise<TripFixture> {
  const code = opts.customerCode ?? "PLG-0034";
  const orderNumber = `P-26-${String(uniqueSeq()).padStart(6, "0")}`;
  const tripNumber = `${orderNumber}/1`;
  const [order] = await db
    .insert(orders)
    .values({
      tenantId: EQUA_TENANT_ID,
      number: orderNumber,
      customerId: customerId(code),
      addressId: seedAddressId(code),
      productId: productId("AIR-TRUK"),
      requestedDate: opts.requestedDate ?? "2026-09-28",
      pricePerTrip: 200_000,
      totalAmount: 200_000,
      priceSource: "zone",
      recurringOrderId: opts.recurringOrderId ?? null,
    })
    .returning({ id: orders.id });
  const [trip] = await db
    .insert(trips)
    .values({
      tenantId: EQUA_TENANT_ID,
      orderId: order!.id,
      number: tripNumber,
      sequenceInOrder: 1,
      customerId: customerId(code),
      addressId: seedAddressId(code),
      scheduledDate: opts.tripDate ?? "2026-09-28",
      price: 200_000,
      paymentMethod: "cash",
    })
    .returning({ id: trips.id });
  return { orderId: order!.id, tripId: trip!.id, orderNumber, tripNumber, customerId: customerId(code) };
}

/** Shift outlet (bawaan: D01, status Ditutup agar tidak bentrok dengan "satu shift terbuka per outlet"). */
export async function createShiftFixture(
  db: DbOrTx,
  opts: { outletCode?: string; outletId?: string; tenantId?: string; status?: "open" | "closed"; syncConflict?: boolean; operator?: string } = {},
): Promise<{ shiftId: string; outletId: string; tenantId: string }> {
  const outlet = opts.outletId ?? outletId(opts.outletCode ?? "D01");
  const tenantId = opts.tenantId ?? EQUA_TENANT_ID;
  const status = opts.status ?? "closed";
  const [row] = await db
    .insert(shifts)
    .values({
      tenantId,
      outletId: outlet,
      operatorUserId: userIdByUsername(opts.operator ?? "depot01"),
      businessDate: "2026-09-28",
      status,
      openedAt: new Date("2026-09-28T00:00:00Z"),
      closedAt: status === "closed" ? new Date("2026-09-28T10:00:00Z") : null,
      openingCashFixed: 200_000,
      syncConflict: opts.syncConflict ?? false,
    })
    .returning({ id: shifts.id });
  return { shiftId: row!.id, outletId: outlet, tenantId };
}

export type PosSaleFixture = { saleId: string; lineId: string; localNumber: string };

/** Transaksi POS tunai 2 × isi ulang (Rp 10.000) + satu baris pada shift yang diberikan. */
export async function createPosSaleFixture(
  db: DbOrTx,
  shift: { shiftId: string; outletId: string; tenantId: string },
  opts: {
    total?: number;
    quantity?: number;
    number?: string | null;
    localNumber?: string;
    deviceId?: string | null;
    reversalOfId?: string;
    isReversal?: boolean;
  } = {},
): Promise<PosSaleFixture> {
  const quantity = opts.quantity ?? 2;
  const total = opts.total ?? quantity * 5_000;
  const localNumber = opts.localNumber ?? `D01-280926-P1-${String(uniqueSeq()).padStart(6, "0")}`;
  const [sale] = await db
    .insert(posSales)
    .values({
      tenantId: shift.tenantId,
      outletId: shift.outletId,
      shiftId: shift.shiftId,
      number: opts.number ?? null,
      localNumber,
      deviceSeq: uniqueSeq(),
      deviceId: opts.deviceId ?? null,
      operatorUserId: userIdByUsername("depot01"),
      priceKind: "standard",
      businessDate: "2026-09-28",
      soldAt: new Date("2026-09-28T02:00:00Z"),
      subtotal: total,
      total,
      paymentMethod: "cash",
      cashReceived: total > 0 ? total : null,
      changeAmount: total > 0 ? 0 : null,
      reversalOfId: opts.reversalOfId ?? null,
      isReversal: opts.isReversal ?? false,
    })
    .returning({ id: posSales.id });
  const [line] = await db
    .insert(posSaleLines)
    .values({
      posSaleId: sale!.id,
      tenantId: shift.tenantId,
      outletId: shift.outletId,
      businessDate: "2026-09-28",
      lineNo: 1,
      productId: productId("ISI-ULANG"),
      quantity,
      unitPrice: 5_000,
      lineTotal: total,
      gallonSizeL: 19,
    })
    .returning({ id: posSaleLines.id });
  return { saleId: sale!.id, lineId: line!.id, localNumber };
}

/** Tenant mitra + satu outlet depot (RL-7) — untuk uji isolasi tenant (NFR-30). */
export async function createPartnerTenant(db: DbOrTx): Promise<{ tenantId: string; outletId: string; code: string }> {
  const tenantId = newId();
  const code = `MTR${uniqueSeq()}`;
  await db.insert(tenants).values({ id: tenantId, code, name: `Mitra uji ${code}`, kind: "partner" });
  const [outlet] = await db
    .insert(outlets)
    .values({ tenantId, code: "M01", name: `Depot mitra ${code}`, kind: "depot" })
    .returning({ id: outlets.id });
  return { tenantId, outletId: outlet!.id, code };
}

/** Periode akuntansi EQUA (dibuat bila belum ada; status diperbarui bila berbeda). */
export async function ensurePeriod(
  db: DbOrTx,
  period: string,
  status: "open" | "closed" | "locked" | "reopened" = "open",
): Promise<string> {
  const start = `${period}-01`;
  const [y, m] = period.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [row] = await db
    .insert(accountingPeriods)
    .values({ tenantId: EQUA_TENANT_ID, period, startDate: start, endDate: end, status })
    .onConflictDoUpdate({ target: [accountingPeriods.tenantId, accountingPeriods.period], set: { status } })
    .returning({ id: accountingPeriods.id });
  return row!.id;
}

export type JournalFixtureLine = { account?: string; debit?: number; credit?: number };

/**
 * Header jurnal + baris (bawaan: posted, seimbang Rp 100.000 kas ↔ pendapatan) dalam SATU transaksi — constraint
 * trigger keseimbangan (DEFERRABLE) dicek saat COMMIT.
 */
export async function createJournalFixture(
  db: DbOrTx,
  opts: {
    periodId: string;
    status?: "draft" | "posted";
    kind?: "auto" | "manual" | "opening_balance";
    date?: string;
    lines?: JournalFixtureLine[];
    totalDebit?: number;
    totalCredit?: number;
  },
): Promise<{ journalId: string; number: string }> {
  const lines = opts.lines ?? [
    { account: "1-1101", debit: 100_000 },
    { account: "4-1101", credit: 100_000 },
  ];
  const debit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const credit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  // Awalan uji `JU-` (bukan `J-`): sejak D-14 nomor resmi juga 6 digit, jadi `J-2609-000001` dapat bertabrakan dengan `nextNumber`.
  const number = `JU-2609-${String(uniqueSeq()).padStart(6, "0")}`;
  const insert = async (tx: DbOrTx) => {
    const [journal] = await tx
      .insert(journals)
      .values({
        tenantId: EQUA_TENANT_ID,
        number,
        kind: opts.kind ?? "manual",
        status: opts.status ?? "posted",
        journalDate: opts.date ?? "2026-09-15",
        periodId: opts.periodId,
        description: "Jurnal uji",
        totalDebit: opts.totalDebit ?? debit,
        totalCredit: opts.totalCredit ?? credit,
        postedAt: (opts.status ?? "posted") === "posted" ? new Date() : null,
      })
      .returning({ id: journals.id });
    if (lines.length) {
      await tx.insert(journalLines).values(
        lines.map((l, i) => ({
          journalId: journal!.id,
          lineNo: i + 1,
          accountId: accountId(l.account ?? (l.debit ? "1-1101" : "4-1101")),
          profitCenter: "L2" as const,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
        })),
      );
    }
    return journal!.id;
  };
  // Db → BEGIN/COMMIT; DbTransaction → SAVEPOINT (pemeriksaan tertunda terjadi saat COMMIT transaksi luar).
  const journalId = await (db as Db).transaction((tx) => insert(tx));
  return { journalId, number };
}
