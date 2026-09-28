/**
 * Seed demo Produksi & Stok Air (M8) — idempoten (ID deterministik + ON CONFLICT DO NOTHING); tanggal relatif terhadap
 * hari seed dijalankan agar aplikasi operator produksi `/produksi` dan layar kantor `/produksi/*` tidak kosong.
 *
 * Isi (nomor pesanan demo P-YY-9008xx — tidak bertabrakan dengan penomoran otomatis; truk T3 = sumber SA1, T4 = SA2):
 * - SA1 (Cugenang), 3 hari terakhir: angka meter pagi/malam, rit truk T3 Selesai + pengisian terkait rit.
 *   H-3 susut normal; H-2 susut di atas PAR-18 dengan penjelasan operator (Investigasi → pemilik menerima/
 *   mengembalikan); H-1 produksi menyimpang > PAR-68 dari rata-rata (perlu verifikasi Admin Keuangan) + level tandon.
 * - SA2 (Warungkondang): H-2 susut negatif (pengisian > produksi → verifikasi Admin Keuangan); H-1 pembacaan malam
 *   belum ada (produksi "Belum lengkap").
 * - Hari ini: rit terbit T3 (2 rit, pelanggan acuan SA1) & T4 (1 rit, acuan SA2) belum diisi → daftar truk terjadwal
 *   di aplikasi operator; belum ada angka meter hari ini (operator mencatat pagi).
 * - Mutu air: jadwal uji SA1 (90 hari, jatuh tempo 5 hari lagi → pengingat H-7) & depot D01 (180 hari); hasil uji SA1
 *   lulus + hasil D01 tidak lulus dengan tindakan terbuka (penanggung jawab Admin Keuangan).
 * Angka produksi & neraca dihitung dengan aturan yang sama dengan layanan M8 (PAR-18/PAR-68 dari parameter seed), sehingga
 * hitung ulang layanan (mis. koreksi pembacaan) menghasilkan angka yang sama.
 *
 * Dilewati saat snapshot DB uji Vitest dibangun (tanggal relatif); uji M8 memanggilnya langsung dengan `{ force: true }`.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { addDays, toBusinessDate, wibToUtc, type BusinessDate } from "../../lib/time";
import type { DbOrTx } from "../client";
import {
  customerAddresses,
  customers,
  dailyProductions,
  dailySchedules,
  meterReadings,
  orders,
  qualityTests,
  qualityTestSchedules,
  tankLevelReadings,
  trips,
  truckFills,
  waterBalances,
} from "../schema";
import { FUEL_COMPONENT_PER_TRIP, TARIFF_ZONE_SEEDS, productId, tariffZoneId } from "./catalog";
import { seedId } from "./ids";
import { EMPLOYEE_SEEDS, EQUA_TENANT_ID, WATER_SOURCE_SEEDS, deviceId, employeeId, outletId, truckId, userIdByUsername, waterSourceId } from "./org";
import { LAMPIRAN_B_PARAMETERS } from "./parameters";

const emp = (username: string) => employeeId(EMPLOYEE_SEEDS.find((e) => e.username === username)!.no);

/** Pelanggan yang tidak dipakai demo/E2E modul lain — dipilih per sumber acuan alamatnya. */
const CANDIDATE_CUSTOMERS = ["PLG-0009", "PLG-0012", "PLG-0013", "PLG-0015", "PLG-0016", "PLG-0017", "PLG-0030", "PLG-0031", "PLG-0032", "PLG-0040"];

type FillPlan = { time: string; volumeL?: number };
type DayPlan = {
  offset: number;
  morning?: { value: number; time: string };
  evening?: { value: number; time: string };
  fills: FillPlan[];
  tankPct?: number;
  investigation?: { reason: "leakage"; note: string };
};
type SourcePlan = { code: "SA1" | "SA2"; truck: "T3" | "T4"; driver: string; operator: string; days: DayPlan[]; todayTrips: number };

const PLANS: SourcePlan[] = [
  {
    code: "SA1",
    truck: "T3",
    driver: "sopir3",
    operator: "produksi1",
    days: [
      {
        offset: -3,
        morning: { value: 12_452_000, time: "06:15" },
        evening: { value: 12_467_300, time: "21:10" },
        fills: [{ time: "06:45" }, { time: "10:05" }, { time: "13:40" }],
      },
      {
        offset: -2,
        morning: { value: 12_467_300, time: "06:20" },
        evening: { value: 12_483_500, time: "21:05" },
        fills: [{ time: "06:50" }, { time: "10:15" }, { time: "13:30" }],
        investigation: { reason: "leakage", note: "Sambungan pipa ke tandon bocor, sudah diikat sementara (data demo)." },
      },
      {
        offset: -1,
        morning: { value: 12_483_500, time: "06:10" },
        evening: { value: 12_503_900, time: "21:20" },
        fills: [{ time: "06:40" }, { time: "09:30" }, { time: "12:20" }, { time: "15:10" }],
        tankPct: 70,
      },
    ],
    todayTrips: 2,
  },
  {
    code: "SA2",
    truck: "T4",
    driver: "sopir4",
    operator: "produksi4",
    days: [
      {
        offset: -2,
        morning: { value: 8_731_000, time: "06:30" },
        evening: { value: 8_740_800, time: "21:00" },
        fills: [{ time: "07:00" }, { time: "11:00" }],
      },
      {
        offset: -1,
        morning: { value: 8_740_800, time: "06:25" },
        fills: [{ time: "07:10" }, { time: "11:20" }],
      },
    ],
    todayTrips: 1,
  },
];

function param<T>(key: string): T {
  return LAMPIRAN_B_PARAMETERS.find((p) => p.key === key)!.value as T;
}

function pct2(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return Math.max(-99_999.99, Math.min(99_999.99, Math.round((n / d) * 10_000) / 100));
}

async function zonePrice(tx: DbOrTx, addressId: string): Promise<{ price: number; zoneId: string }> {
  const addr = await tx.select({ zoneId: customerAddresses.tariffZoneId }).from(customerAddresses).where(eq(customerAddresses.id, addressId)).limit(1);
  const zoneId = addr[0]?.zoneId ?? tariffZoneId("Z1");
  const zone = TARIFF_ZONE_SEEDS.find((z) => tariffZoneId(z.code) === zoneId) ?? TARIFF_ZONE_SEEDS[0];
  return { price: zone.pricePerTrip + FUEL_COMPONENT_PER_TRIP, zoneId };
}

/** Jadwal harian terbit truk (pakai yang sudah ada bila demo modul lain membuatnya). */
async function scheduleFor(tx: DbOrTx, truck: string, date: BusinessDate, key: string, dispatcher: string): Promise<string> {
  const [existing] = await tx
    .select({ id: dailySchedules.id })
    .from(dailySchedules)
    .where(and(eq(dailySchedules.truckId, truckId(truck)), eq(dailySchedules.businessDate, date)))
    .limit(1);
  if (existing) return existing.id;
  const id = seedId(key);
  await tx
    .insert(dailySchedules)
    .values({ id, tenantId: EQUA_TENANT_ID, truckId: truckId(truck), businessDate: date, status: "published", publishedAt: wibToUtc(date, "05:30"), publishedBy: dispatcher, createdBy: dispatcher })
    .onConflictDoNothing();
  return id;
}

export async function seedDemoM8Production(tx: DbOrTx, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<{ readings: number; fills: number; trips: number }> {
  const out = { readings: 0, fills: 0, trips: 0 };
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return out;
  const today = toBusinessDate(now);
  const yy = today.slice(2, 4);
  const dispatcher = userIdByUsername("dispatcher1");
  const lossMax = param<{ max_percent: number }>("PAR-18").max_percent;
  const deviation = param<{ percent_gt: number; window_days: number }>("PAR-68");
  const standardL = param<{ liters: number }>("PAR-15").liters;

  // Pelanggan demo per sumber acuan alamat utama.
  const addrRows = await tx
    .select({ customerId: customers.id, code: customers.code, addressId: customerAddresses.id, sourceId: customerAddresses.referenceWaterSourceId })
    .from(customers)
    .innerJoin(customerAddresses, eq(customerAddresses.customerId, customers.id))
    .where(and(inArray(customers.code, CANDIDATE_CUSTOMERS), isNotNull(customerAddresses.referenceWaterSourceId)));
  let seq = 800;

  for (const plan of PLANS) {
    const sourceId = waterSourceId(plan.code);
    const src = WATER_SOURCE_SEEDS.find((s) => s.code === plan.code)!;
    const meterId = seedId(`water_meter:${src.meterCode}`);
    const operator = userIdByUsername(plan.operator);
    const device = deviceId(`HP-${plan.code}`);
    const custs = addrRows.filter((r) => r.sourceId === sourceId).sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));
    if (custs.length === 0) continue;
    const priorProductions: number[] = [];
    const priorLosses: number[] = [];

    /** Pesanan + rit (Selesai untuk hari lalu, Ditugaskan & terbit untuk hari ini). */
    const tripFor = async (date: BusinessDate, key: string, route: number, time: string, completed: boolean): Promise<string | null> => {
      const cust = custs[(route - 1) % custs.length]!;
      const { price, zoneId } = await zonePrice(tx, cust.addressId);
      const orderId = seedId(`m8:order:${key}`);
      const tripId = seedId(`m8:trip:${key}`);
      const number = `P-${yy}-${String(900_000 + ++seq).padStart(6, "0")}`;
      const created = wibToUtc(addDays(date, -1), "15:30");
      const at = wibToUtc(date, time);
      const doneAt = new Date(at.getTime() + 75 * 60_000);
      const scheduleId = await scheduleFor(tx, plan.truck, date, `m8:schedule:${plan.truck}:${date === today ? 0 : key}`, dispatcher);
      const res = await tx
        .insert(orders)
        .values({
          id: orderId,
          tenantId: EQUA_TENANT_ID,
          number,
          customerId: cust.customerId,
          addressId: cust.addressId,
          productId: productId("AIR-TRUK"),
          status: completed ? "completed" : "scheduled",
          source: "office",
          tankCount: 1,
          requestedDate: date,
          requestedTime: null,
          paymentMethod: "cash",
          pricePerTrip: price,
          totalAmount: price,
          priceSource: "zone",
          tariffZoneId: zoneId,
          notes: "Data demo produksi air (M8).",
          scheduledAt: created,
          completedAt: completed ? doneAt : null,
          firstDepartedAt: completed ? at : null,
          createdBy: dispatcher,
          createdAt: created,
        })
        .onConflictDoNothing()
        .returning({ id: orders.id });
      if (!res[0]) {
        const [t] = await tx.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).limit(1);
        return t?.id ?? null;
      }
      await tx
        .insert(trips)
        .values({
          id: tripId,
          tenantId: EQUA_TENANT_ID,
          orderId,
          number: `${number}/1`,
          sequenceInOrder: 1,
          status: completed ? "completed" : "assigned",
          customerId: cust.customerId,
          addressId: cust.addressId,
          truckId: truckId(plan.truck),
          scheduledDate: date,
          scheduleId,
          routeOrder: route,
          publishedAt: wibToUtc(date, "05:30"),
          price,
          paymentMethod: "cash",
          plannedVolumeL: standardL,
          driverEmployeeId: emp(plan.driver),
          actualOrder: completed ? route : null,
          departedAt: completed ? new Date(at.getTime() + 15 * 60_000) : null,
          arrivedAt: completed ? new Date(at.getTime() + 55 * 60_000) : null,
          completedAt: completed ? doneAt : null,
          completionBusinessDate: completed ? date : null,
          deliveredVolumeL: completed ? standardL : null,
          recipientName: completed ? "Pemilik rumah (demo)" : null,
          createdBy: dispatcher,
          createdAt: created,
        })
        .onConflictDoNothing();
      out.trips++;
      return tripId;
    };

    for (const day of plan.days) {
      const date = addDays(today, day.offset);
      const k = `${plan.code}:${day.offset}`;
      // --- Pengisian (terkait rit Selesai) ---------------------------------------------------------------------------
      let filledL = 0;
      for (const [i, f] of day.fills.entries()) {
        const tripId = await tripFor(date, `${k}:${i + 1}`, i + 1, f.time, true);
        const volumeL = f.volumeL ?? standardL;
        filledL += volumeL;
        const filledAt = wibToUtc(date, f.time);
        const res = await tx
          .insert(truckFills)
          .values({
            id: seedId(`m8:fill:${k}:${i + 1}`),
            tenantId: EQUA_TENANT_ID,
            waterSourceId: sourceId,
            truckId: truckId(plan.truck),
            tripId,
            businessDate: date,
            volumeL,
            filledAt,
            recordedBy: operator,
            status: tripId ? "linked" : "unlinked",
            deviceId: device,
            deviceTime: filledAt,
            syncedAt: new Date(filledAt.getTime() + 2 * 60_000),
            createdBy: operator,
            createdAt: filledAt,
          })
          .onConflictDoNothing()
          .returning({ id: truckFills.id });
        if (res[0]) out.fills++;
      }

      // --- Pembacaan meter ------------------------------------------------------------------------------------------
      const readingIds: Record<"morning" | "evening", string | null> = { morning: null, evening: null };
      for (const phase of ["morning", "evening"] as const) {
        const r = day[phase];
        if (!r) continue;
        const id = seedId(`m8:reading:${k}:${phase}`);
        readingIds[phase] = id;
        const readAt = wibToUtc(date, r.time);
        const res = await tx
          .insert(meterReadings)
          .values({
            id,
            tenantId: EQUA_TENANT_ID,
            waterSourceId: sourceId,
            waterMeterId: meterId,
            businessDate: date,
            phase,
            readingL: r.value,
            readAt,
            recordedBy: operator,
            status: "recorded",
            deviceId: device,
            deviceTime: readAt,
            syncedAt: new Date(readAt.getTime() + 60_000),
            createdBy: operator,
            createdAt: readAt,
          })
          .onConflictDoNothing()
          .returning({ id: meterReadings.id });
        if (res[0]) out.readings++;
      }

      // --- Produksi harian (aturan US-M8-01: Σ akhir − awal; KP-4 penyimpangan dari rata-rata PAR-68) ------------------
      const complete = !!day.morning && !!day.evening;
      const producedL = complete ? day.evening!.value - day.morning!.value : null;
      let deviationPct: number | null = null;
      let flagged = false;
      if (producedL !== null && priorProductions.length) {
        const avg = priorProductions.reduce((a, b) => a + b, 0) / priorProductions.length;
        deviationPct = pct2(producedL - avg, avg);
        flagged = deviationPct !== null && Math.abs(deviationPct) > deviation.percent_gt;
      }
      const detail = [
        {
          meterId,
          meterCode: src.meterCode,
          startL: day.morning?.value ?? null,
          startFrom: day.morning ? "morning" : null,
          startReadingId: readingIds.morning,
          endL: day.evening?.value ?? null,
          endFrom: day.evening ? "evening" : null,
          endReadingId: readingIds.evening,
          rolloverAtL: null,
          producedL,
          missing: [...(day.morning ? [] : ["morning"]), ...(day.evening ? [] : ["evening"])],
        },
      ];
      const computedAt = wibToUtc(date, day.evening?.time ?? "23:00");
      await tx
        .insert(dailyProductions)
        .values({
          id: seedId(`m8:production:${k}`),
          tenantId: EQUA_TENANT_ID,
          waterSourceId: sourceId,
          businessDate: date,
          producedL,
          status: complete ? "complete" : "incomplete",
          incompleteReason: complete ? null : `Belum ada pembacaan malam ${src.meterCode}.`,
          detail,
          deviationPct,
          flaggedForVerification: flagged,
          computedAt,
        })
        .onConflictDoNothing();
      if (flagged) {
        for (const id of Object.values(readingIds)) {
          if (id) await tx.update(meterReadings).set({ status: "flagged", anomalyNote: `Produksi menyimpang ${deviationPct}% dari rata-rata ${deviation.window_days} hari (PAR-68).` }).where(eq(meterReadings.id, id));
        }
      }

      // --- Neraca air harian (US-M8-04) ----------------------------------------------------------------------------
      const lossL = producedL === null ? null : producedL - filledL;
      const lossPct = producedL === null || lossL === null ? null : pct2(lossL, producedL);
      const avgLoss = priorLosses.length ? Math.round((priorLosses.reduce((a, b) => a + b, 0) / priorLosses.length) * 100) / 100 : null;
      let status: "formed" | "normal" | "over_threshold" | "investigating" | "negative_anomaly" = "formed";
      if (lossL !== null) status = lossL < 0 ? "negative_anomaly" : lossPct !== null && lossPct > lossMax ? "over_threshold" : "normal";
      if (status === "over_threshold" && day.investigation) status = "investigating";
      await tx
        .insert(waterBalances)
        .values({
          id: seedId(`m8:balance:${k}`),
          tenantId: EQUA_TENANT_ID,
          waterSourceId: sourceId,
          businessDate: date,
          producedL,
          filledCustomerL: filledL,
          filledDepotL: 0,
          filledTotalL: filledL,
          returnedL: 0,
          lossL,
          lossPct,
          avgLoss7dPct: avgLoss,
          utilizationPct: pct2(filledL, 50_000),
          isIncomplete: producedL === null,
          status,
          investigationReason: status === "investigating" ? day.investigation!.reason : null,
          investigationNote: status === "investigating" ? day.investigation!.note : null,
          investigatedBy: status === "investigating" ? operator : null,
          investigatedAt: status === "investigating" ? wibToUtc(addDays(date, 1), "07:05") : null,
          computedAt,
        })
        .onConflictDoNothing();
      if (producedL !== null) priorProductions.push(producedL);
      if (lossPct !== null) priorLosses.push(lossPct);

      if (day.tankPct !== undefined) {
        const readAt = wibToUtc(date, "15:00");
        await tx
          .insert(tankLevelReadings)
          .values({ id: seedId(`m8:tank:${k}`), tenantId: EQUA_TENANT_ID, waterSourceId: sourceId, businessDate: date, levelPct: day.tankPct, readAt, recordedBy: operator, notes: "Tandon utama", deviceId: device, deviceTime: readAt, syncedAt: readAt })
          .onConflictDoNothing();
      }
    }

    // --- Rit hari ini (terbit, belum diisi) → daftar truk terjadwal aplikasi operator ----------------------------------
    for (let i = 1; i <= plan.todayTrips; i++) await tripFor(today, `${plan.code}:today:${i}`, i, i === 1 ? "08:00" : "11:00", false);
  }

  // --- Mutu air (US-M8-06) -------------------------------------------------------------------------------------------
  const owner = userIdByUsername("pemilik");
  const finance = userIdByUsername("keuangan1");
  const sa1Schedule = seedId("m8:quality_schedule:SA1");
  const d01Schedule = seedId("m8:quality_schedule:D01");
  await tx
    .insert(qualityTestSchedules)
    .values([
      {
        id: sa1Schedule,
        tenantId: EQUA_TENANT_ID,
        locationType: "water_source",
        waterSourceId: waterSourceId("SA1"),
        frequencyDays: 90,
        nextDueDate: addDays(today, 5),
        laboratory: "Labkesda Kab. Cianjur",
        parameters: ["E. coli", "Total coliform", "TDS", "pH", "Kekeruhan"],
        createdBy: owner,
      },
      {
        id: d01Schedule,
        tenantId: EQUA_TENANT_ID,
        locationType: "outlet",
        outletId: outletId("D01"),
        frequencyDays: 180,
        nextDueDate: addDays(today, 40),
        laboratory: "Labkesda Kab. Cianjur",
        parameters: ["E. coli", "Total coliform", "TDS"],
        createdBy: owner,
      },
    ])
    .onConflictDoNothing();
  await tx
    .insert(qualityTests)
    .values([
      {
        id: seedId("m8:quality_test:SA1:1"),
        tenantId: EQUA_TENANT_ID,
        scheduleId: sa1Schedule,
        locationType: "water_source",
        waterSourceId: waterSourceId("SA1"),
        testDate: addDays(today, -85),
        laboratory: "Labkesda Kab. Cianjur",
        results: [
          { parameter: "E. coli", value: "0", unit: "CFU/100 mL", limit: "0", passed: true },
          { parameter: "Total coliform", value: "0", unit: "CFU/100 mL", limit: "0", passed: true },
          { parameter: "TDS", value: "142", unit: "mg/L", limit: "300", passed: true },
          { parameter: "pH", value: "7,1", unit: null, limit: "6,5–8,5", passed: true },
          { parameter: "Kekeruhan", value: "0,8", unit: "NTU", limit: "3", passed: true },
        ],
        passed: true,
        createdBy: finance,
      },
      {
        id: seedId("m8:quality_test:D01:1"),
        tenantId: EQUA_TENANT_ID,
        scheduleId: d01Schedule,
        locationType: "outlet",
        outletId: outletId("D01"),
        testDate: addDays(today, -20),
        laboratory: "Labkesda Kab. Cianjur",
        results: [
          { parameter: "E. coli", value: "0", unit: "CFU/100 mL", limit: "0", passed: true },
          { parameter: "Total coliform", value: "12", unit: "CFU/100 mL", limit: "0", passed: false },
          { parameter: "TDS", value: "118", unit: "mg/L", limit: "300", passed: true },
        ],
        passed: false,
        actionRequired: "Sterilisasi ulang toren & ganti filter UV, lalu uji ulang (data demo).",
        actionOwnerEmployeeId: emp("keuangan1"),
        actionDueDate: addDays(today, 2),
        createdBy: finance,
      },
    ])
    .onConflictDoNothing();

  return out;
}
