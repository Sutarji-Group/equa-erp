/**
 * Pembantu uji modul M7 (bukan berkas uji): toko uji tersendiri (outlet kind store + tablet POS + kasir ber-PIN) agar
 * data demo toko TK1 tidak memengaruhi hasil, pemasok aktif, pembangun perintah sinkron `m6.*` (penjualan/shift toko)
 * dan `m7.*` (nota, opname, transfer, usulan), serta pengisi stok lewat nota pemasok.
 */
import { hash } from "@node-rs/argon2";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";

import type { Db } from "@/db/client";
import { devices, notifications, outlets, stockBalances, suppliers, users } from "@/db/schema";
import { EQUA_TENANT_ID, productId, SEED_DEMO_PIN } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import type { FieldLoginResult } from "@/server/core/auth";
import type { PushResult } from "@/server/core/sync";

import { seededContext } from "../helpers/context";
import { createTestUser, type TestUser } from "../helpers/factories";
import { fieldDevice, type FieldDevice, type SignedCommandOptions } from "../helpers/field";

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

/** Barang toko seed (harga umum / mitra). */
export const SP = {
  GALON: productId("TK-GALON-KOSONG"),
  TUTUP: productId("TK-TUTUP"),
  TISU: productId("TK-TISU"),
  SABUN: productId("TK-SABUN"),
  FILTER: productId("TK-FILTER-10"),
  UV: productId("TK-LAMPU-UV"),
  POMPA: productId("TK-POMPA"),
  SIKAT: productId("TK-SIKAT"),
  DISPENSER: productId("TK-DISPENSER"),
} as const;
export const GENERAL = { GALON: 40_000, TUTUP: 800, TISU: 400, SABUN: 30_000, FILTER: 35_000, UV: 150_000, POMPA: 25_000, SIKAT: 20_000, DISPENSER: 850_000 } as const;
export const PARTNER = { GALON: 35_000, TUTUP: 600, TISU: 300, SABUN: 26_000, FILTER: 30_000, UV: 135_000, POMPA: 22_000, SIKAT: 17_000, DISPENSER: 780_000 } as const;

export const owner = () => seededContext("pemilik");
export const finance = () => seededContext("keuangan1");
export const accountant = () => seededContext("akuntan");

export type StorePos = {
  hp: FieldDevice;
  op: FieldLoginResult;
  outletId: string;
  outletCode: string;
  deviceCode: string;
  cashier: TestUser;
  send: (type: string, payload: unknown, opts?: SignedCommandOptions & { now?: Date }) => Promise<PushResult>;
  seq: () => number;
};

let storeCounter = 0;

/** Toko uji baru (tenant EQUA) + kasir ber-PIN + tablet POS terdaftar untuk toko itu. */
export async function makeStore(db: Db, opts: { code?: string } = {}): Promise<StorePos> {
  storeCounter++;
  const code = opts.code ?? `TU${storeCounter}${Math.random().toString(36).slice(2, 4).toUpperCase()}`.replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const outletId = newId();
  await db.insert(outlets).values({ id: outletId, tenantId: EQUA_TENANT_ID, code, name: `Toko Uji ${code}`, kind: "store", address: "Jl. Uji", isActive: true });
  const cashier = await createTestUser(db, { role: "store_cashier", scope: { outletIds: [outletId] }, fullName: `Kasir ${code}` });
  await db.update(users).set({ pinHash: await hash(SEED_DEMO_PIN), pinSetAt: new Date() }).where(eq(users.id, cashier.userId));
  const deviceId = newId();
  const deviceCode = `POS-${code}`;
  await db.insert(devices).values({ id: deviceId, tenantId: EQUA_TENANT_ID, deviceCode, name: `Tablet ${code}`, kind: "tablet", status: "registered", outletId });
  const hp = await fieldDevice(deviceId);
  const op = await hp.login(cashier.userId);
  let n = 0;
  return {
    hp,
    op,
    outletId,
    outletCode: code,
    deviceCode,
    cashier,
    send: async (type, payload, o = {}) => (await hp.push([hp.command(op, type, payload, o)], { now: o.now })).results[0]!,
    seq: () => ++n,
  };
}

export function expectApplied(res: PushResult) {
  expect(res.status, `${res.code ?? ""} ${res.message ?? ""}`).toBe("applied");
}

export function expectRejected(res: PushResult, pattern?: RegExp) {
  expect(res.status, `${res.code ?? ""} ${res.message ?? ""}`).toBe("rejected");
  if (pattern) expect(res.message ?? "").toMatch(pattern);
}

export function localNo(pos: Pick<StorePos, "outletCode">, seq: number, date = toBusinessDate(new Date())) {
  return `${pos.outletCode}-${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}-UJI-${String(seq).padStart(4, "0")}`;
}

/** Pemasok aktif (disetujui) untuk uji. */
export async function activeSupplier(db: Db, name = `Pemasok Uji ${Math.random().toString(36).slice(2, 6)}`, paymentTermDays: number | null = null): Promise<string> {
  const id = newId();
  await db.insert(suppliers).values({ id, tenantId: EQUA_TENANT_ID, name, status: "active", paymentTermDays });
  return id;
}

export type ReceiptLine = { productId: string; quantity: number; unitCost: number };

/** Penerimaan barang dari nota pemasok (foto nota diunggah). */
export async function receiveVia(
  pos: StorePos,
  input: { supplierId: string; lines: ReceiptLine[]; noteNumber?: string | null; noteDate?: string | null; dueDate?: string | null; substitute?: boolean; notes?: string | null; photo?: boolean; total?: number },
  cmd: SignedCommandOptions & { now?: Date } = {},
) {
  const receiptId = newId();
  const cmdId = newId();
  const withPhoto = input.photo ?? true;
  const up = withPhoto ? await pos.hp.upload(pos.op, { bytes: JPEG, kind: input.substitute ? "goods_photo" : "supplier_note", commandId: cmdId }) : null;
  const seq = pos.seq();
  const res = await pos.send(
    "m7.purchase_receipt.create",
    {
      receiptId,
      localNumber: `${pos.outletCode}-NB-${String(seq).padStart(4, "0")}`,
      deviceSeq: seq,
      supplierId: input.supplierId,
      isSubstitute: input.substitute ?? false,
      supplierNoteNumber: input.noteNumber === undefined ? `N-${receiptId.slice(-6)}` : input.noteNumber,
      supplierNoteDate: input.noteDate === undefined ? toBusinessDate(new Date()) : input.noteDate,
      dueDate: input.dueDate ?? null,
      lines: input.lines,
      totalAmount: input.total ?? input.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0),
      notes: input.notes ?? null,
    },
    { id: cmdId, ...(up ? { attachmentIds: [up.attachmentId], attachmentHashes: [up.sha256] } : {}), ...cmd },
  );
  return { receiptId, res };
}

/** Isi stok toko uji lewat nota pemasok. */
export async function stockUp(db: Db, pos: StorePos, lines: ReceiptLine[], supplierId?: string) {
  const sup = supplierId ?? (await activeSupplier(db));
  const r = await receiveVia(pos, { supplierId: sup, lines });
  expectApplied(r.res);
  return { ...r, supplierId: sup };
}

export async function openShiftVia(pos: StorePos, opts: { counted?: number; shiftId?: string } = {}) {
  const shiftId = opts.shiftId ?? newId();
  const res = await pos.send("m6.shift.open", { shiftId, openingCashCounted: opts.counted ?? 200_000 });
  expectApplied(res);
  return shiftId;
}

export type SaleOpts = {
  customerId?: string | null;
  method?: "cash" | "qris" | "credit";
  cashReceived?: number | null;
  discountAmount?: number;
  discountReason?: string | null;
  requestApproval?: boolean;
  creditOffline?: boolean;
  saleId?: string;
  cmd?: SignedCommandOptions & { now?: Date };
};

/** Transaksi toko lewat perintah kerangka POS `m6.pos_sale.create`. */
export async function sellVia(pos: StorePos, shiftId: string, lines: { productId: string; quantity: number; unitPrice: number }[], opts: SaleOpts = {}) {
  const saleId = opts.saleId ?? newId();
  const seq = pos.seq();
  const date = opts.cmd?.businessDate ?? toBusinessDate(opts.cmd?.deviceTime ? new Date(opts.cmd.deviceTime) : new Date());
  const payload: Record<string, unknown> = {
    saleId,
    shiftId,
    localNumber: localNo(pos, seq, date),
    deviceSeq: seq,
    lines,
    paymentMethod: opts.method ?? "cash",
    ...(opts.customerId !== undefined ? { customerId: opts.customerId } : {}),
    ...(opts.cashReceived !== undefined ? { cashReceived: opts.cashReceived } : {}),
    ...(opts.discountAmount !== undefined ? { discountAmount: opts.discountAmount } : {}),
    ...(opts.discountReason !== undefined ? { discountReason: opts.discountReason } : {}),
    ...(opts.requestApproval !== undefined ? { requestApproval: opts.requestApproval } : {}),
    ...(opts.creditOffline !== undefined ? { creditOffline: opts.creditOffline } : {}),
  };
  const res = await pos.send("m6.pos_sale.create", payload, opts.cmd);
  return { saleId, res };
}

export async function closeVia(pos: StorePos, shiftId: string, counted: number, reason?: string | null) {
  return pos.send("m6.shift.close", { shiftId, closingCashCounted: counted, cashDifferenceReason: reason ?? null, stock: [], saleIds: [], voidedSaleIds: [] });
}

export async function balanceOf(db: Db, outlet: string, product: string): Promise<number> {
  const [b] = await db.select().from(stockBalances).where(and(eq(stockBalances.outletId, outlet), eq(stockBalances.productId, product)));
  return b?.quantity ?? 0;
}

export async function notificationsFor(db: Db, event: string, opts: { objectId?: string; recipient?: string } = {}) {
  const rows = await db.select().from(notifications).where(eq(notifications.event, event));
  return rows.filter((r) => (!opts.objectId || r.objectId === opts.objectId) && (!opts.recipient || r.recipientUserId === opts.recipient));
}
