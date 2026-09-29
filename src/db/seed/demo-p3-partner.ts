/**
 * Seed demo P3 — Kemitraan (RL-7 Paket Minimum Mitra Fase 1). Idempoten: seluruh data demo ditulis SEKALI (penanda:
 * tenant mitra demo belum ada); ID deterministik; nomor faktur memakai urutan resmi (`document_sequences`). Event domain
 * TIDAK dipancarkan (seed menulis langsung, seperti seed demo modul lain). Dilewati di Vitest (tanggal relatif hari ini)
 * kecuali `force: true`.
 *
 * Isi (relatif terhadap `now`) agar layar /kemitraan/* dan portal /mitra/* berisi:
 * - Tenant mitra `MTR-SKL` "Depot Mitra Sukaluyu" (outlet depot M01, katalog depot EQUA tersalin, harga jual mitra
 *   dengan harga anjuran EQUA), pelanggan mitra PLG-0901 (segmen depot pihak ketiga, penanda mitra depot EQUA + mitra
 *   toko BR-18) tertaut ke tenant & outlet, kontrak Opsi B Aktif (langganan Rp 150.000/outlet) + wilayah eksklusif.
 * - Akun: `mitra1` (Pemilik mitra, portal, kata sandi demo), `opmitra1` (Operator depot mitra, PIN demo, tablet
 *   TAB-MTR01), `pembina1` (Pembina wilayah EQUA, web kantor tanpa 2FA).
 * - Penjualan POS mitra (shift tertutup, galon isi ulang) sejak awal bulan lalu s.d. kemarin; pasokan air truk EQUA
 *   dikonfirmasi tiap ±3 hari + satu pasokan "Tiba" hari ini (menunggu konfirmasi operator); buku air (stok awal,
 *   pasokan, galon terjual).
 * - Tagihan langganan sistem: 2 bulan lalu (lunas transfer) & bulan lalu (terbuka, jatuh tempo tgl 15).
 * - Permintaan dukungan: satu Selesai (ditanggapi 5 jam), satu masih Diajukan.
 * - Laporan bulanan mitra bulan lalu (terbit tanggal 5) — bila hari ini ≥ tanggal 5.
 */
import { hash } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";

import { addDays, firstDayOfMonth, lastDayOfMonth, toBusinessDate, wibToUtc, type BusinessDate } from "@/lib/time";

import type { DbOrTx } from "../client";
import {
  customerAddresses,
  customerPayments,
  customers,
  devices,
  documentSequences,
  employees,
  exclusiveTerritories,
  invoiceLines,
  invoices,
  outlets,
  outletWaterLedger,
  partnerContracts,
  partnerMonthlyReports,
  partnerSupportRequests,
  paymentAllocations,
  posSaleLines,
  posSales,
  productPrices,
  products,
  shifts,
  tenants,
  userRoles,
  users,
  userScopes,
  waterSupplyReceipts,
} from "../schema";
import { tariffZoneId } from "./catalog";
import { SEED_DEMO_PASSWORD, SEED_DEMO_PIN } from "./constants";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, userIdByUsername } from "./org";

export const P3_DEMO_TENANT_CODE = "MTR-SKL";
export const P3_DEMO_TENANT_ID = seedId(`tenant:${P3_DEMO_TENANT_CODE}`);
export const P3_DEMO_OUTLET_ID = seedId("p3:demo:outlet:MTR-SKL:M01");
export const P3_DEMO_CUSTOMER_ID = seedId("p3:demo:customer:PLG-0901");
export const P3_DEMO_CONTRACT_ID = seedId("p3:demo:contract:MTR-SKL");
export const P3_DEMO_DEVICE_ID = seedId("p3:demo:device:TAB-MTR01");

const OUTLET_POINT = { lat: -6.7712, lng: 107.0935 };
const SUBSCRIPTION = 150_000;
const GALLON_L = 19;
const PARTNER_PRICE = 6_000;

const yy = (d: BusinessDate) => d.slice(2, 4);
const MONTH = (d: BusinessDate) => d.slice(0, 7);

/** Nomor berikutnya (logika sama dengan core/numbering `nextNumber`, tanpa impor server-only). */
async function nextSeq(tx: DbOrTx, scopeKey: string): Promise<number> {
  const rows = await tx
    .insert(documentSequences)
    .values({ id: seedId(`p3:demo:seq:invoice:${scopeKey}:first`), tenantId: EQUA_TENANT_ID, kind: "invoice", scopeKey, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.tenantId, documentSequences.kind, documentSequences.scopeKey],
      set: { lastValue: sql`${documentSequences.lastValue} + 1`, updatedAt: new Date() },
    })
    .returning({ lastValue: documentSequences.lastValue });
  return Number(rows[0]!.lastValue);
}

/** Galon terjual per hari (deterministik, 60–100). */
function gallonsOn(date: BusinessDate): number {
  const n = Number(date.slice(8, 10)) + Number(date.slice(5, 7)) * 3;
  return 60 + ((n * 37) % 41);
}

export type P3DemoSummary = { created: boolean; sales: number; invoices: number };

export async function seedDemoP3Partner(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<P3DemoSummary> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { created: false, sales: 0, invoices: 0 };
  const [exists] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, P3_DEMO_TENANT_ID)).limit(1);
  if (exists) return { created: false, sales: 0, invoices: 0 };

  const today = toBusinessDate(now);
  const monthStart = firstDayOfMonth(today);
  const prevMonthStart = firstDayOfMonth(addDays(monthStart, -1));
  const prev2MonthStart = firstDayOfMonth(addDays(prevMonthStart, -1));
  const contractStart = firstDayOfMonth(addDays(prev2MonthStart, -1));
  /** Waktu WIB pada tanggal tertentu, tidak melewati `now`. */
  const at = (date: BusinessDate, time: string) => {
    const t = wibToUtc(date, time);
    return t > now ? now : t;
  };
  const finance = userIdByUsername("keuangan1");
  const admin = userIdByUsername("admin1");

  // --- Tenant, outlet, katalog ------------------------------------------------------------------------------------
  await tx.insert(tenants).values({ id: P3_DEMO_TENANT_ID, code: P3_DEMO_TENANT_CODE, name: "Depot Mitra Sukaluyu", kind: "partner", settings: { createdFromStandardCatalog: true, demo: true } });
  await tx.insert(outlets).values({
    id: P3_DEMO_OUTLET_ID,
    tenantId: P3_DEMO_TENANT_ID,
    code: "M01",
    name: "Depot Mitra Sukaluyu",
    kind: "depot",
    address: "Jl. Raya Sukaluyu No. 12, Cianjur",
    lat: OUTLET_POINT.lat,
    lng: OUTLET_POINT.lng,
    storageCapacityL: 5_000,
    qrisEnabled: true,
    activatedOn: contractStart,
    billingStartDate: contractStart,
  });
  const equaDepotProducts = await tx.select().from(products).where(sql`${products.tenantId} = ${EQUA_TENANT_ID} and ${products.line} = 'depot' and ${products.status} = 'active'`);
  const productIdOf = new Map<string, string>();
  for (const p of equaDepotProducts) {
    const id = seedId(`p3:demo:product:${p.code}`);
    productIdOf.set(p.code, id);
    await tx.insert(products).values({
      id,
      tenantId: P3_DEMO_TENANT_ID,
      code: p.code,
      name: p.name,
      line: p.line,
      category: p.category,
      unit: p.unit,
      isInternalTransfer: false,
      isConsumable: p.isConsumable,
      gallonSizeL: p.gallonSizeL,
      minStock: p.minStock,
      posVisible: p.posVisible,
      sortOrder: p.sortOrder,
      sourceProductId: p.id,
      status: "active",
      createdBy: admin,
    });
    const [equaPrice] = await tx
      .select({ price: productPrices.price })
      .from(productPrices)
      .where(sql`${productPrices.productId} = ${p.id} and ${productPrices.kind} = 'standard' and ${productPrices.status} = 'active' and ${productPrices.outletId} is null`)
      .limit(1);
    if (equaPrice && !p.isConsumable) {
      await tx.insert(productPrices).values({
        id: seedId(`p3:demo:price:${p.code}`),
        tenantId: P3_DEMO_TENANT_ID,
        productId: id,
        kind: "standard",
        price: p.code === "ISI-ULANG" ? PARTNER_PRICE : equaPrice.price,
        recommendedPrice: equaPrice.price,
        effectiveFrom: contractStart,
        status: "active",
        isOwnerDirect: true,
        reason: "Harga jual mitra (PTB-56) — data demo.",
        approvedBy: admin,
        approvedAt: at(contractStart, "08:00"),
        createdBy: admin,
      });
    }
  }
  const isiUlang = productIdOf.get("ISI-ULANG");

  // --- Akun mitra & pembina -----------------------------------------------------------------------------------------
  const [passwordHash, pinHash] = await Promise.all([hash(SEED_DEMO_PASSWORD), hash(SEED_DEMO_PIN)]);
  const people = [
    { username: "mitra1", no: "MTR-001", tenantId: P3_DEMO_TENANT_ID, fullName: "Hj. Euis Kurniasih", position: "Pemilik mitra", role: "partner_owner" as const, scope: { type: "tenant" as const, refId: P3_DEMO_TENANT_ID } },
    { username: "opmitra1", no: "MTR-002", tenantId: P3_DEMO_TENANT_ID, fullName: "Asep Saepudin", position: "Operator depot mitra", role: "depot_operator" as const, scope: { type: "outlet" as const, refId: P3_DEMO_OUTLET_ID } },
    { username: "pembina1", no: "EQ-P01", tenantId: EQUA_TENANT_ID, fullName: "Ridwan Hidayat", position: "Pembina wilayah", role: "regional_coach" as const, scope: { type: "tenant" as const, refId: EQUA_TENANT_ID } },
  ];
  for (const p of people) {
    const employeeId = seedId(`p3:demo:employee:${p.no}`);
    const userId = userIdByUsername(p.username);
    await tx.insert(employees).values({
      id: employeeId,
      tenantId: p.tenantId,
      employeeNo: p.no,
      fullName: p.fullName,
      position: p.position,
      workLocation: p.tenantId === EQUA_TENANT_ID ? "Kantor EQUA Cianjur" : "Depot Mitra Sukaluyu",
      primaryOutletId: p.role === "depot_operator" ? P3_DEMO_OUTLET_ID : null,
      intendedRoles: [p.role],
      hireDate: contractStart,
    });
    await tx.insert(users).values({
      id: userId,
      tenantId: p.tenantId,
      employeeId,
      username: p.username,
      passwordHash,
      passwordChangedAt: now,
      pinHash: p.role === "depot_operator" ? pinHash : null,
      pinSetAt: p.role === "depot_operator" ? now : null,
      status: "active",
      activatedAt: now,
    });
    await tx.insert(userRoles).values({
      id: seedId(`user_role:${p.username}:${p.role}`),
      userId,
      role: p.role,
      status: "active",
      validFrom: contractStart,
      reason: "Akun kemitraan demo — disetujui pemilik (US-M10-01 KP-8).",
      grantedAt: now,
    });
    await tx.insert(userScopes).values({
      id: seedId(`user_scope:${p.username}:${p.scope.type}:${p.scope.refId}`),
      userId,
      scopeType: p.scope.type,
      refId: p.scope.refId,
      status: "active",
      validFrom: contractStart,
      reason: "Lingkup akun kemitraan demo.",
    });
  }
  const operator = userIdByUsername("opmitra1");
  await tx.update(outlets).set({ defaultOperatorEmployeeId: seedId("p3:demo:employee:MTR-002") }).where(eq(outlets.id, P3_DEMO_OUTLET_ID));
  await tx.insert(devices).values({ id: P3_DEMO_DEVICE_ID, tenantId: P3_DEMO_TENANT_ID, deviceCode: "TAB-MTR01", name: "Tablet POS Mitra Sukaluyu", kind: "tablet", status: "registered", outletId: P3_DEMO_OUTLET_ID });

  // --- Pelanggan mitra (tenant EQUA) & kontrak -------------------------------------------------------------------
  await tx.insert(customers).values({
    id: P3_DEMO_CUSTOMER_ID,
    tenantId: EQUA_TENANT_ID,
    code: "PLG-0901",
    name: "Depot Mitra Sukaluyu (mitra)",
    segment: "third_party_depot",
    waPhone: "6281390000901",
    contactName: "Hj. Euis Kurniasih",
    notes: "Mitra Depot EQUA (RL-7) — data demo.",
    creditStatus: "credit",
    creditLimit: 3_000_000,
    paymentTermDays: 14,
    monthlyBilling: true,
    isStorePartner: true,
    storePartnerSource: "manual",
    isEquaPartner: true,
    partnerTenantId: P3_DEMO_TENANT_ID,
    partnerOutletId: P3_DEMO_OUTLET_ID,
  });
  await tx.insert(customerAddresses).values({
    id: seedId("address:PLG-0901:utama"),
    customerId: P3_DEMO_CUSTOMER_ID,
    label: "Depot",
    addressText: "Jl. Raya Sukaluyu No. 12, Cianjur",
    lat: OUTLET_POINT.lat,
    lng: OUTLET_POINT.lng,
    coordinateStatus: "unlocked",
    tariffZoneId: tariffZoneId("Z1"),
    zoneAssignment: "manual",
    zoneManualReason: "Alamat outlet mitra (data demo).",
  });
  const endDate = addDays(firstDayOfMonth(addDays(contractStart, 800)), -1);
  await tx.insert(partnerContracts).values({
    id: P3_DEMO_CONTRACT_ID,
    tenantId: P3_DEMO_TENANT_ID,
    customerId: P3_DEMO_CUSTOMER_ID,
    number: `KM-${yy(contractStart)}-0901`,
    option: "option_b",
    initialFee: 0,
    subscriptionFeePerOutlet: SUBSCRIPTION,
    royaltyBp: 0,
    waterDiscountBp: 0,
    exclusiveRadiusM: 1_000,
    termMonths: 24,
    startDate: contractStart,
    endDate,
    creditLimit: 3_000_000,
    monthlyBilling: true,
    status: "active",
    evaluationIntervalMonths: 3,
    nextEvaluationDate: firstDayOfMonth(addDays(contractStart, 185)),
    createdBy: finance,
  });
  await tx.insert(exclusiveTerritories).values({ id: seedId("p3:demo:territory:MTR-SKL:M01"), contractId: P3_DEMO_CONTRACT_ID, outletId: P3_DEMO_OUTLET_ID, centerLat: OUTLET_POINT.lat, centerLng: OUTLET_POINT.lng, radiusM: 1_000, validFrom: contractStart, validUntil: endDate });

  // --- Buku air, pasokan, penjualan POS ---------------------------------------------------------------------------
  let balance = 3_000;
  await tx.insert(outletWaterLedger).values({ id: seedId("p3:demo:water:opening"), tenantId: P3_DEMO_TENANT_ID, outletId: P3_DEMO_OUTLET_ID, businessDate: addDays(prevMonthStart, -1), kind: "opening", volumeL: balance, balanceAfterL: balance, occurredAt: at(addDays(prevMonthStart, -1), "07:00") });
  const daily: { businessDate: BusinessDate; gallons: number; sales: number; supplyL: number }[] = [];
  let sales = 0;
  for (let d = prevMonthStart, i = 0; d < today; d = addDays(d, 1), i++) {
    let supplyL = 0;
    if (i % 3 === 0) {
      supplyL = 5_000;
      const receiptId = seedId(`p3:demo:supply:${d}`);
      await tx.insert(waterSupplyReceipts).values({
        id: receiptId,
        tenantId: P3_DEMO_TENANT_ID,
        outletId: P3_DEMO_OUTLET_ID,
        source: "equa_truck",
        status: "confirmed",
        deliveredVolumeL: 5_000,
        receivedVolumeL: 5_000,
        differenceL: 0,
        confirmedAt: at(d, "09:10"),
        confirmedBy: operator,
        businessDate: d,
        deviceId: P3_DEMO_DEVICE_ID,
      });
      balance += supplyL;
      await tx.insert(outletWaterLedger).values({ id: seedId(`p3:demo:water:supply:${d}`), tenantId: P3_DEMO_TENANT_ID, outletId: P3_DEMO_OUTLET_ID, businessDate: d, kind: "supply_in", volumeL: supplyL, balanceAfterL: balance, sourceObjectType: "water_supply_receipt", sourceObjectId: receiptId, occurredAt: at(d, "09:10") });
    }
    const gallons = gallonsOn(d);
    const shiftId = seedId(`p3:demo:shift:${d}`);
    const openedAt = at(d, "07:00");
    const closedAt = at(d, "20:00");
    const total = gallons * PARTNER_PRICE;
    await tx.insert(shifts).values({
      id: shiftId,
      tenantId: P3_DEMO_TENANT_ID,
      outletId: P3_DEMO_OUTLET_ID,
      operatorUserId: operator,
      businessDate: d,
      status: "closed",
      openedAt,
      closedAt,
      openingCashFixed: 200_000,
      openingCashCounted: 200_000,
      cashSales: total,
      qrisSales: 0,
      expectedCash: 200_000 + total,
      closingCashCounted: 200_000 + total - (i % 11 === 5 ? 6_000 : 0),
      cashDifference: i % 11 === 5 ? -6_000 : 0,
      cashDifferenceReason: i % 11 === 5 ? "Uang kembalian kurang (dicatat mitra)" : null,
    });
    // Dua transaksi per hari (pagi & sore) agar laporan per transaksi berisi.
    const split = [Math.ceil(gallons / 2), Math.floor(gallons / 2)];
    for (let k = 0; k < split.length; k++) {
      const qty = split[k]!;
      const soldAt = at(d, k === 0 ? "10:15" : "16:40");
      const saleId = seedId(`p3:demo:sale:${d}:${k}`);
      const seq = i * 2 + k + 1;
      await tx.insert(posSales).values({
        id: saleId,
        tenantId: P3_DEMO_TENANT_ID,
        outletId: P3_DEMO_OUTLET_ID,
        shiftId,
        number: `M01-${d.slice(2).replace(/-/g, "")}-${String(k + 1).padStart(4, "0")}`,
        localNumber: `M01-${d.slice(2).replace(/-/g, "")}-TAB-MTR01-${String(seq).padStart(4, "0")}`,
        deviceSeq: seq,
        priceKind: "standard",
        businessDate: d,
        soldAt,
        subtotal: qty * PARTNER_PRICE,
        total: qty * PARTNER_PRICE,
        paymentMethod: "cash",
        cashReceived: qty * PARTNER_PRICE,
        changeAmount: 0,
        operatorUserId: operator,
        status: "valid",
        deviceId: P3_DEMO_DEVICE_ID,
      });
      if (isiUlang) {
        await tx.insert(posSaleLines).values({ id: seedId(`p3:demo:sale_line:${d}:${k}`), posSaleId: saleId, tenantId: P3_DEMO_TENANT_ID, outletId: P3_DEMO_OUTLET_ID, businessDate: d, lineNo: 1, productId: isiUlang, quantity: qty, unitPrice: PARTNER_PRICE, lineTotal: qty * PARTNER_PRICE, gallonSizeL: GALLON_L });
      }
      sales++;
    }
    balance -= gallons * GALLON_L;
    await tx.insert(outletWaterLedger).values({ id: seedId(`p3:demo:water:sales_out:${d}`), tenantId: P3_DEMO_TENANT_ID, outletId: P3_DEMO_OUTLET_ID, businessDate: d, kind: "sales_out", volumeL: -gallons * GALLON_L, balanceAfterL: balance, sourceObjectType: "shift", sourceObjectId: shiftId, occurredAt: closedAt });
    daily.push({ businessDate: d, gallons, sales: total, supplyL });
  }
  // Pasokan hari ini: "Tiba" — menunggu konfirmasi operator mitra di POS (US-P3-08 KP-2).
  await tx.insert(waterSupplyReceipts).values({ id: seedId(`p3:demo:supply:arrived:${today}`), tenantId: P3_DEMO_TENANT_ID, outletId: P3_DEMO_OUTLET_ID, source: "equa_truck", status: "arrived", deliveredVolumeL: 5_000, businessDate: today });

  // --- Tagihan langganan sistem (M5) ----------------------------------------------------------------------------
  const invoiceSpecs = [
    { key: "prev2", month: MONTH(prev2MonthStart), issueDate: prevMonthStart, dueDate: addDays(prevMonthStart, 14), paid: true },
    { key: "prev", month: MONTH(prevMonthStart), issueDate: monthStart, dueDate: addDays(monthStart, 14), paid: false },
  ];
  let invoiceCount = 0;
  for (const s of invoiceSpecs) {
    const id = seedId(`p3:demo:invoice:${s.key}`);
    const number = `F-${yy(s.issueDate)}-${String(await nextSeq(tx, yy(s.issueDate))).padStart(6, "0")}`;
    await tx.insert(invoices).values({
      id,
      tenantId: EQUA_TENANT_ID,
      number,
      kind: "partner_subscription",
      customerId: P3_DEMO_CUSTOMER_ID,
      periodMonth: `${s.month}-01`,
      partnerContractId: P3_DEMO_CONTRACT_ID,
      issueDate: s.issueDate,
      dueDate: s.dueDate,
      amount: SUBSCRIPTION,
      paidAmount: s.paid ? SUBSCRIPTION : 0,
      outstandingAmount: s.paid ? 0 : SUBSCRIPTION,
      status: s.paid ? "paid" : "open",
      paidAt: s.paid ? at(addDays(s.issueDate, 9), "10:30") : null,
      description: `Tagihan bulanan mitra Depot Mitra Sukaluyu — ${s.month} (kontrak KM-${yy(contractStart)}-0901)`,
      createdBy: finance,
      createdAt: at(s.issueDate, "00:40"),
    });
    await tx.insert(invoiceLines).values({ id: seedId(`p3:demo:invoice_line:${s.key}`), invoiceId: id, lineNo: 1, component: "subscription", description: `Langganan sistem ${s.month} — 1 outlet × Rp 150.000 (PAR-35)`, quantity: 1, unitPrice: SUBSCRIPTION, amount: SUBSCRIPTION });
    if (s.paid) {
      const paymentId = seedId(`p3:demo:payment:${s.key}`);
      await tx.insert(customerPayments).values({ id: paymentId, tenantId: EQUA_TENANT_ID, customerId: P3_DEMO_CUSTOMER_ID, channel: "office", method: "transfer", amount: SUBSCRIPTION, businessDate: addDays(s.issueDate, 9), advanceAmount: 0, notes: "Transfer langganan sistem mitra (data demo).", createdBy: finance, createdAt: at(addDays(s.issueDate, 9), "10:30") });
      await tx.insert(paymentAllocations).values({ id: seedId(`p3:demo:payment:${s.key}:alloc`), invoiceId: id, customerPaymentId: paymentId, amount: SUBSCRIPTION, allocatedAt: at(addDays(s.issueDate, 9), "10:30"), createdBy: finance });
    }
    invoiceCount++;
  }

  // --- Dukungan teknis --------------------------------------------------------------------------------------------
  const sub1 = at(addDays(today, -6), "08:20");
  await tx.insert(partnerSupportRequests).values({
    id: seedId("p3:demo:support:done"),
    tenantId: P3_DEMO_TENANT_ID,
    outletId: P3_DEMO_OUTLET_ID,
    kind: "equipment",
    description: "Lampu UV pada jalur isi ulang mati sejak pagi; air tetap disaring tetapi sterilisasi tidak menyala.",
    status: "done",
    submittedAt: sub1,
    submittedBy: userIdByUsername("mitra1"),
    slaDueAt: new Date(sub1.getTime() + 48 * 3_600_000),
    respondedAt: new Date(sub1.getTime() + 5 * 3_600_000),
    respondedBy: userIdByUsername("pembina1"),
    response: "Lampu UV pengganti dikirim ikut truk besok pagi; sementara hentikan isi ulang jalur 2.",
    doneAt: new Date(sub1.getTime() + 26 * 3_600_000),
  });
  const sub2 = at(addDays(today, -1), "15:05");
  await tx.insert(partnerSupportRequests).values({
    id: seedId("p3:demo:support:open"),
    tenantId: P3_DEMO_TENANT_ID,
    outletId: P3_DEMO_OUTLET_ID,
    kind: "system",
    description: "Tablet POS sempat tidak bisa sinkron sore ini; antrean data 12 transaksi.",
    status: "submitted",
    submittedAt: sub2,
    submittedBy: userIdByUsername("mitra1"),
    slaDueAt: new Date(sub2.getTime() + 48 * 3_600_000),
  });

  // --- Laporan bulanan mitra bulan lalu (terbit tanggal 5) --------------------------------------------------------
  if (today >= addDays(monthStart, 4)) {
    const month = MONTH(prevMonthStart);
    const rows = daily.filter((r) => MONTH(r.businessDate) === month);
    const totals = {
      salesTotal: rows.reduce((s, r) => s + r.sales, 0),
      gallons: rows.reduce((s, r) => s + r.gallons, 0),
      voidCount: 0,
      supplyReceivedL: rows.reduce((s, r) => s + r.supplyL, 0),
      invoiced: SUBSCRIPTION,
      paid: SUBSCRIPTION,
      outstanding: 0,
    };
    const soldL = totals.gallons * GALLON_L;
    const availableL = 3_000 + totals.supplyReceivedL;
    const excessL = Math.max(0, soldL - availableL);
    const excessPct = availableL ? Math.round((excessL / availableL) * 10_000) / 100 : 0;
    const sla = { month, total: 0, responded: 0, respondedOnTime: 0, late: 0, open: 0, done: 0, avgResponseHours: null, compliancePct: null, slaHours: 48 };
    const data = {
      tenantId: P3_DEMO_TENANT_ID,
      tenantName: "Depot Mitra Sukaluyu",
      programName: "Kemitraan Depot EQUA",
      month,
      from: prevMonthStart,
      to: lastDayOfMonth(prevMonthStart),
      generatedAt: at(addDays(monthStart, 4), "06:30").toISOString(),
      outlets: [{ outletId: P3_DEMO_OUTLET_ID, outletCode: "M01", outletName: "Depot Mitra Sukaluyu", salesTotal: totals.salesTotal, transactions: rows.length * 2, gallons: totals.gallons, voidCount: 0, voidAmount: 0, cashDifference: 0, shiftsClosed: rows.length, supplyCount: rows.filter((r) => r.supplyL).length, supplyReceivedL: totals.supplyReceivedL }],
      daily: rows.map((r) => ({ outletCode: "M01", businessDate: r.businessDate, salesTotal: r.sales, transactions: 2, gallons: r.gallons, voidCount: 0, voidAmount: 0, cashDifference: 0, shiftsClosed: 1 })),
      waterBalance: [
        { tenantId: P3_DEMO_TENANT_ID, outletId: P3_DEMO_OUTLET_ID, outletCode: "M01", outletName: "Depot Mitra Sukaluyu", month, openingL: 3_000, receivedFromEquaL: totals.supplyReceivedL, otherSourceL: 0, adjustmentL: 0, soldL, gallonsSold: totals.gallons, availableL, excessL, excessPct, tolerancePct: 10, exceeded: excessPct > 10 },
      ],
      purchases: null,
      invoices: [],
      payments: [],
      sla,
      quality: [],
      totals,
    };
    await tx.insert(partnerMonthlyReports).values({ id: seedId(`p3:demo:monthly_report:${month}`), tenantId: P3_DEMO_TENANT_ID, period: month, data, slaSummary: sla, publishedAt: at(addDays(monthStart, 4), "06:30") });
  }

  return { created: true, sales, invoices: invoiceCount };
}
