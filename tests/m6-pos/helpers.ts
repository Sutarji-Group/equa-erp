/**
 * Pembantu uji modul M6 (bukan berkas uji): perangkat POS + login PIN operator, pembangun perintah sinkron `m6.*`,
 * pengisi stok bahan, dan pembuat tenant uji (isolasi NFR-30).
 *
 * Outlet demo seed M6 (D02, D03) TIDAK dipakai uji agar data demo tidak memengaruhi hasil.
 */
import { hash } from "@node-rs/argon2";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";

import type { Db } from "@/db/client";
import { devices, notifications, outlets, users } from "@/db/schema";
import { outletId, productId, SEED_DEMO_PIN, userIdByUsername } from "@/db/seed";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import type { FieldLoginResult } from "@/server/core/auth";
import type { PushResult } from "@/server/core/sync";

import { seededContext } from "../helpers/context";
import { createTestUser, type TestUser } from "../helpers/factories";
import { fieldDevice, type FieldDevice, type SignedCommandOptions } from "../helpers/field";

export const PRICE = { ISI: 5_000, GALON_BARU: 45_000, TUTUP: 1_000, TISU: 500, CUCI: 2_000 } as const;
export const P = {
  ISI: productId("ISI-ULANG"),
  GALON_BARU: productId("GALON-BARU"),
  TUTUP: productId("TUTUP"),
  TISU: productId("TISU"),
  GALON_KOSONG: productId("GALON-KOSONG"),
  CUCI: productId("CUCI-GALON"),
} as const;

export const owner = () => seededContext("pemilik");
export const finance = () => seededContext("keuangan1");
export const admin = () => seededContext("admin1");

export type Pos = {
  hp: FieldDevice;
  op: FieldLoginResult;
  outletId: string;
  outletCode: string;
  deviceCode: string;
  /** Kirim satu/lebih perintah dan kembalikan hasil pertama. */
  send: (type: string, payload: unknown, opts?: SignedCommandOptions & { now?: Date }) => Promise<PushResult>;
  seq: () => number;
};

/** Perangkat POS seed (`POS-Dxx`) + login operator outlet itu. */
export async function posFor(code: string, username?: string): Promise<Pos> {
  const hp = await fieldDevice(`POS-${code}`);
  const op = await hp.login(username ?? `depot${code.slice(1)}`);
  let n = 0;
  return {
    hp,
    op,
    outletId: outletId(code),
    outletCode: code,
    deviceCode: `POS-${code}`,
    send: async (type, payload, opts = {}) => {
      const res = await hp.push([hp.command(op, type, payload, opts)], { now: opts.now });
      return res.results[0]!;
    },
    seq: () => ++n,
  };
}

export function localNumber(pos: Pick<Pos, "outletCode" | "deviceCode">, seq: number, date = toBusinessDate(new Date())): string {
  return `${pos.outletCode}-${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}-${pos.deviceCode.replace(/[^A-Z0-9]/g, "")}-${String(seq).padStart(4, "0")}`;
}

export async function openShiftVia(pos: Pos, opts: { counted?: number; shiftId?: string; cmd?: SignedCommandOptions } = {}) {
  const shiftId = opts.shiftId ?? newId();
  const res = await pos.send("m6.shift.open", { shiftId, openingCashCounted: opts.counted ?? 200_000 }, opts.cmd);
  return { shiftId, res };
}

export type SaleLine = { productId: string; quantity: number; unitPrice: number };

export async function sellVia(
  pos: Pos,
  shiftId: string,
  lines: SaleLine[],
  opts: { method?: "cash" | "qris"; cashReceived?: number | null; qrisReference?: string | null; saleId?: string; replacesSaleId?: string; cmd?: SignedCommandOptions & { now?: Date }; extra?: Record<string, unknown> } = {},
) {
  const saleId = opts.saleId ?? newId();
  const seq = pos.seq();
  const date = opts.cmd?.businessDate ?? toBusinessDate(opts.cmd?.deviceTime ? new Date(opts.cmd.deviceTime) : new Date());
  const payload: Record<string, unknown> = {
    saleId,
    shiftId,
    localNumber: localNumber(pos, seq, date),
    deviceSeq: seq,
    lines,
    paymentMethod: opts.method ?? "cash",
    ...(opts.cashReceived !== undefined ? { cashReceived: opts.cashReceived } : {}),
    ...(opts.qrisReference !== undefined ? { qrisReference: opts.qrisReference } : {}),
    ...(opts.replacesSaleId ? { replacesSaleId: opts.replacesSaleId } : {}),
    ...opts.extra,
  };
  const res = await pos.send("m6.pos_sale.create", payload, opts.cmd);
  return { saleId, res, localNumber: payload.localNumber as string };
}

export const isi = (quantity = 1, unitPrice: number = PRICE.ISI): SaleLine => ({ productId: P.ISI, quantity, unitPrice });
export const galonBaru = (quantity = 1, unitPrice: number = PRICE.GALON_BARU): SaleLine => ({ productId: P.GALON_BARU, quantity, unitPrice });

/** Isi stok bahan lewat penerimaan "lainnya" (tanpa nota wajib). */
export async function stockUp(pos: Pos, qty: { tutup?: number; tisu?: number; galonKosong?: number } = {}, unitCost = 500) {
  const lines = [
    { productId: P.TUTUP, quantity: qty.tutup ?? 100, unitCost },
    { productId: P.TISU, quantity: qty.tisu ?? 100, unitCost: Math.round(unitCost / 2) },
    { productId: P.GALON_KOSONG, quantity: qty.galonKosong ?? 20, unitCost: 30_000 },
  ].filter((l) => l.quantity > 0);
  const res = await pos.send("m6.consumable_receipt.create", { receiptId: newId(), source: "other", lines, notes: "Stok awal uji" });
  expect(res.status, res.message ?? "").toBe("applied");
  return res;
}

/** Tutup shift dengan hitung fisik "pas" (stok fisik = seharusnya bila tidak diberikan). */
export async function closeVia(
  pos: Pos,
  shiftId: string,
  input: { counted: number; reason?: string | null; stock?: { productId: string; physicalQty: number; reason?: string | null; deviceExpectedQty?: number | null }[]; saleIds?: string[]; voidedSaleIds?: string[]; deviceExpectedDrawer?: number | null },
  cmd?: SignedCommandOptions & { now?: Date },
) {
  return pos.send(
    "m6.shift.close",
    {
      shiftId,
      closingCashCounted: input.counted,
      cashDifferenceReason: input.reason ?? null,
      stock: input.stock ?? [],
      saleIds: input.saleIds ?? [],
      voidedSaleIds: input.voidedSaleIds ?? [],
      ...(input.deviceExpectedDrawer !== undefined ? { deviceExpectedDrawer: input.deviceExpectedDrawer } : {}),
    },
    cmd,
  );
}

export async function notificationsFor(db: Db, event: string, opts: { objectId?: string; recipient?: string } = {}) {
  const rows = await db.select().from(notifications).where(eq(notifications.event, event));
  return rows.filter((r) => (!opts.objectId || r.objectId === opts.objectId) && (!opts.recipient || r.recipientUserId === opts.recipient));
}

export function expectApplied(res: PushResult) {
  expect(res.status, `${res.code ?? ""} ${res.message ?? ""}`).toBe("applied");
}

// =====================================================================================================================
// Tenant uji (US-M6-07)
// =====================================================================================================================

export type TestTenant = {
  tenantId: string;
  outletId: string;
  outletCode: string;
  deviceId: string;
  deviceCode: string;
  operator: TestUser;
  sysadmin: TestUser;
  owner: TestUser;
  pos: () => Promise<Pos>;
};

/** Buat tenant mitra uji lewat layanan M6 (salinan katalog standar) + operator, pemilik, perangkat POS. */
export async function makeTestTenant(db: Db, create: (code: string) => Promise<{ tenantId: string; outletId: string; outletCode: string }>, code = "UJI"): Promise<TestTenant> {
  const t = await create(code);
  const sysadmin = await createTestUser(db, { role: "system_admin", tenantId: t.tenantId, scope: { tenantIds: [t.tenantId] } });
  const ownerUser = await createTestUser(db, { role: "owner", tenantId: t.tenantId, scope: { tenantIds: [t.tenantId] } });
  const operator = await createTestUser(db, { role: "depot_operator", tenantId: t.tenantId, scope: { outletIds: [t.outletId] } });
  await db.update(users).set({ pinHash: await hash(SEED_DEMO_PIN), pinSetAt: new Date() }).where(eq(users.id, operator.userId));
  const deviceId = newId();
  const deviceCode = `POS-${code}1`;
  await db.insert(devices).values({ id: deviceId, tenantId: t.tenantId, deviceCode, name: `Tablet POS ${code}`, kind: "tablet", status: "registered", outletId: t.outletId });
  return {
    ...t,
    deviceId,
    deviceCode,
    operator,
    sysadmin,
    owner: ownerUser,
    pos: async () => {
      const hp = await fieldDevice(deviceId, { admin: sysadmin.ctx });
      const op = await hp.login(operator.userId);
      let n = 0;
      return {
        hp,
        op,
        outletId: t.outletId,
        outletCode: t.outletCode,
        deviceCode,
        send: async (type, payload, opts = {}) => (await hp.push([hp.command(op, type, payload, opts)], { now: opts.now })).results[0]!,
        seq: () => ++n,
      };
    },
  };
}

export async function outletByCode(db: Db, tenantId: string, code: string) {
  const [row] = await db.select().from(outlets).where(and(eq(outlets.tenantId, tenantId), eq(outlets.code, code))).limit(1);
  return row!;
}

export const depot = (code: string) => outletId(code);
export const userOf = (username: string) => userIdByUsername(username);
