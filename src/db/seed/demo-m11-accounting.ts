/**
 * Seed M11 (idempoten; ID deterministik + ON CONFLICT DO NOTHING):
 *
 * 1. `seedM11AccountingDefaults` — pelengkap bagan akun & pemetaan bawaan agar SETIAP peristiwa wajib 7.11.4 terpetakan
 *    (US-M11-01 KP-2): akun alokasi biaya bersama (6-9301/6-9302) + pemetaan tambahan (selisih setoran depot/toko,
 *    pengeluaran rit lain, setor bank outlet/sopir, selisih kas kantor & kas kecil, nota kredit per lini, uang muka,
 *    alokasi L1 & biaya bersama, pelepasan aset, ekuitas penyeimbang saldo awal). Ditinjau akuntan sebelum go-live (K9).
 * 2. `seedDemoM11Accounting` — data demo agar layar Akuntansi tidak kosong: jurnal contoh bulan berjalan (nomor
 *    berawalan `JD-` agar tidak memakai urutan resmi `J-YYMM-NNNNN`), jurnal berulang sewa, dua aset tetap.
 *    Tanggal cut-over TIDAK diisi (tetap keputusan pemilik). Seperti demo modul lain, data transaksi demo dilewati di
 *    DB uji (`VITEST`/`NODE_ENV=test`) kecuali `force`.
 */
import { and, eq } from "drizzle-orm";

import { REQUIRED_MAPPINGS } from "@/server/modules/m11-accounting/constants";

import {
  firstDayOfMonth,
  lastDayOfMonth,
  monthOf,
  toBusinessDate,
} from "../../lib/time";
import type { DbOrTx } from "../client";
import {
  accountingPeriods,
  accounts,
  eventAccountMappings,
  fixedAssetExtras,
  fixedAssets,
  journalLines,
  journals,
  recurringJournals,
} from "../schema";
import { accountId, EVENT_MAPPING_SEEDS } from "./accounting";
import { SEED_EFFECTIVE_FROM } from "./constants";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, outletId, truckId, userIdByUsername } from "./org";

type Pc = "L1" | "L2" | "L3" | "L4" | "L5" | "SHARED";

const EXTRA_ACCOUNTS = [
  {
    code: "6-9301",
    name: "Beban alokasi biaya bersama",
    type: "expense" as const,
    normal: "debit" as const,
    pc: "SHARED" as Pc,
  },
  {
    code: "6-9302",
    name: "Alokasi biaya bersama — keluar",
    type: "expense" as const,
    normal: "credit" as const,
    pc: "SHARED" as Pc,
  },
];

type ExtraMapping = {
  event: string;
  entry: string;
  description: string;
  debit: string;
  credit: string;
  debitPc?: Pc | null;
  creditPc?: Pc | null;
  rule?: string;
};

/** Pemetaan tambahan M11 (melengkapi `EVENT_MAPPING_SEEDS`). */
export const M11_EXTRA_MAPPINGS: ExtraMapping[] = [
  {
    event: "deposit.received",
    entry: "shortage_depot_shift",
    description: "Selisih kurang setoran shift depot → beban selisih kas",
    debit: "6-1601",
    credit: "1-1103",
    creditPc: "L3",
    rule: "from_source",
  },
  {
    event: "deposit.received",
    entry: "shortage_store_shift",
    description: "Selisih kurang setoran shift toko → beban selisih kas",
    debit: "6-1601",
    credit: "1-1104",
    creditPc: "L4",
    rule: "from_source",
  },
  {
    event: "expense.verified",
    entry: "other",
    description: "Pengeluaran rit lain dari kas di tangan",
    debit: "6-9101",
    credit: "1-1102",
    debitPc: "L2",
    creditPc: "L2",
  },
  {
    event: "expense.verified",
    entry: "personal_toll_parking",
    description: "Tol/parkir uang pribadi diganti kas kantor",
    debit: "5-1302",
    credit: "1-1101",
    debitPc: "L2",
    creditPc: "SHARED",
  },
  {
    event: "expense.verified",
    entry: "personal_other",
    description: "Pengeluaran rit lain uang pribadi diganti kas kantor",
    debit: "6-9101",
    credit: "1-1101",
    debitPc: "L2",
    creditPc: "SHARED",
  },
  {
    event: "bank_deposit.recorded",
    entry: "outlet_depot",
    description: "Setor kas outlet depot ke bank",
    debit: "1-1201",
    credit: "1-1103",
    debitPc: "SHARED",
    creditPc: "L3",
    rule: "from_outlet",
  },
  {
    event: "bank_deposit.recorded",
    entry: "outlet_store",
    description: "Setor kas outlet toko ke bank",
    debit: "1-1201",
    credit: "1-1104",
    debitPc: "SHARED",
    creditPc: "L4",
  },
  {
    event: "bank_deposit.recorded",
    entry: "driver",
    description: "Setor kas sopir ke bank (slip)",
    debit: "1-1201",
    credit: "1-1102",
    debitPc: "SHARED",
    creditPc: "L2",
  },
  {
    event: "office_cash.moved",
    entry: "adjustment_in",
    description: "Selisih lebih hitung fisik kas kantor",
    debit: "1-1101",
    credit: "4-9101",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "office_cash.moved",
    entry: "adjustment_out",
    description: "Selisih kurang hitung fisik kas kantor",
    debit: "6-1601",
    credit: "1-1101",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "petty_cash.recorded",
    entry: "adjustment_over",
    description: "Selisih lebih hitung fisik kas kecil",
    debit: "1-1105",
    credit: "4-9101",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "petty_cash.recorded",
    entry: "adjustment_short",
    description: "Selisih kurang hitung fisik kas kecil",
    debit: "6-1601",
    credit: "1-1105",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "consumable.received",
    entry: "other",
    description: "Penerimaan bahan depot sumber lain (kas outlet)",
    debit: "1-1502",
    credit: "1-1103",
    debitPc: "L3",
    creditPc: "L3",
    rule: "from_outlet",
  },
  {
    event: "credit_note.issued",
    entry: "L2",
    description: "Nota kredit air truk: pembalik pendapatan / piutang",
    debit: "4-1101",
    credit: "1-1401",
    debitPc: "L2",
    creditPc: "SHARED",
  },
  {
    event: "credit_note.issued",
    entry: "L3",
    description: "Nota kredit depot: pembalik pendapatan / piutang",
    debit: "4-1201",
    credit: "1-1401",
    debitPc: "L3",
    creditPc: "SHARED",
  },
  {
    event: "credit_note.issued",
    entry: "L4",
    description: "Nota kredit toko: pembalik pendapatan / piutang",
    debit: "4-1301",
    credit: "1-1401",
    debitPc: "L4",
    creditPc: "SHARED",
  },
  {
    event: "credit_note.issued",
    entry: "L5",
    description: "Nota kredit kemitraan: pembalik pendapatan / piutang",
    debit: "4-1401",
    credit: "1-1401",
    debitPc: "L5",
    creditPc: "SHARED",
  },
  {
    event: "credit_note.issued",
    entry: "advance",
    description:
      "Bagian nota kredit melampaui sisa faktur → uang muka pelanggan",
    debit: "1-1401",
    credit: "2-1201",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "credit_note.issued",
    entry: "opening_adjustment",
    description: "Nota kredit faktur saldo awal → ekuitas saldo awal",
    debit: "3-1901",
    credit: "1-1401",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "customer_advance.refunded",
    entry: "cash",
    description: "Pengembalian uang muka pelanggan tunai",
    debit: "2-1201",
    credit: "1-1101",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "customer_advance.refunded",
    entry: "transfer",
    description: "Pengembalian uang muka pelanggan transfer",
    debit: "2-1201",
    credit: "1-1201",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "customer_advance.applied",
    entry: "default",
    description: "Uang muka pelanggan dipakai pada faktur: uang muka / piutang (B-65)",
    debit: "2-1201",
    credit: "1-1401",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "m11.allocation",
    entry: "l1_allocation",
    description: "Alokasi biaya produksi air L1 → L2/L3 (PAR-65)",
    debit: "5-1501",
    credit: "5-1502",
    debitPc: null,
    creditPc: "L1",
  },
  {
    event: "m11.allocation",
    entry: "shared_costs",
    description: "Alokasi biaya bersama ke lini (kunci pemilik)",
    debit: "6-9301",
    credit: "6-9302",
    debitPc: null,
    creditPc: "SHARED",
  },
  {
    event: "m11.asset_disposal",
    entry: "gain_loss",
    description:
      "Pelepasan aset: debit = rugi pelepasan, kredit = laba pelepasan",
    debit: "6-9201",
    credit: "4-9201",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
  {
    event: "m11.opening_balance",
    entry: "equity_balancing",
    description: "Ekuitas penyeimbang saldo awal",
    debit: "3-1901",
    credit: "3-1901",
    debitPc: "SHARED",
    creditPc: "SHARED",
  },
];

export async function seedM11AccountingDefaults(tx: DbOrTx): Promise<void> {
  await tx
    .insert(accounts)
    .values(
      EXTRA_ACCOUNTS.map((a) => ({
        id: accountId(a.code),
        tenantId: EQUA_TENANT_ID,
        code: a.code,
        name: a.name,
        type: a.type,
        normalBalance: a.normal,
        parentId: accountId("6-0000"),
        isPostable: true,
        profitCenter: a.pc,
      })),
    )
    .onConflictDoNothing();
  const existing = new Set(
    EVENT_MAPPING_SEEDS.map((m) => `${m.event}|${m.entry}`),
  );
  const extra = M11_EXTRA_MAPPINGS.filter(
    (m) => !existing.has(`${m.event}|${m.entry}`),
  );
  await tx
    .insert(eventAccountMappings)
    .values(
      extra.map((m) => ({
        id: seedId(
          `event_mapping:${m.event}:${m.entry}:${SEED_EFFECTIVE_FROM}`,
        ),
        tenantId: EQUA_TENANT_ID,
        eventKey: m.event,
        entryKey: m.entry,
        description: m.description,
        debitAccountId: accountId(m.debit),
        creditAccountId: accountId(m.credit),
        debitProfitCenter: m.debitPc ?? null,
        creditProfitCenter: m.creditPc ?? null,
        profitCenterRule: m.rule ?? "fixed",
        effectiveFrom: SEED_EFFECTIVE_FROM,
      })),
    )
    .onConflictDoNothing();
  // Penjaga: setiap pemetaan wajib punya baris (gagal keras bila katalog bertambah tanpa seed).
  const covered = new Set([
    ...existing,
    ...M11_EXTRA_MAPPINGS.map((m) => `${m.event}|${m.entry}`),
  ]);
  const missing = REQUIRED_MAPPINGS.filter(
    (r) => !covered.has(`${r.event}|${r.entry}`),
  );
  if (missing.length)
    throw new Error(
      `Seed M11: pemetaan wajib belum ada: ${missing.map((m) => `${m.event}/${m.entry}`).join(", ")}`,
    );
}

type DemoLine = {
  account: string;
  pc: Pc;
  debit?: number;
  credit?: number;
  outlet?: string;
  truck?: string;
  memo?: string;
};
type DemoJournal = {
  key: string;
  kind: "auto" | "manual";
  day: number;
  description: string;
  sourceType: string;
  lines: DemoLine[];
  review?: boolean;
};

const DEMO_JOURNALS: DemoJournal[] = [
  {
    key: "trip-revenue",
    kind: "auto",
    day: 2,
    description: "[Demo] Pendapatan air truk rit tunai",
    sourceType: "trip.completed",
    lines: [
      { account: "1-1102", pc: "L2", debit: 12_500_000, truck: "T1" },
      { account: "4-1101", pc: "L2", credit: 12_500_000, truck: "T1" },
    ],
  },
  {
    key: "trip-credit",
    kind: "auto",
    day: 3,
    description: "[Demo] Pendapatan air truk rit tempo",
    sourceType: "trip.completed",
    lines: [
      { account: "1-1401", pc: "SHARED", debit: 4_200_000, truck: "T2" },
      { account: "4-1101", pc: "L2", credit: 4_200_000, truck: "T2" },
    ],
  },
  {
    key: "deposit",
    kind: "auto",
    day: 3,
    description: "[Demo] Setoran sopir diterima",
    sourceType: "deposit.received",
    lines: [
      { account: "1-1101", pc: "SHARED", debit: 12_450_000 },
      { account: "6-1601", pc: "L2", debit: 50_000, memo: "Selisih kurang" },
      { account: "1-1102", pc: "L2", credit: 12_500_000 },
    ],
  },
  {
    key: "depot-sales",
    kind: "auto",
    day: 4,
    description: "[Demo] Penjualan POS depot D01 tunai",
    sourceType: "pos_sale.recorded",
    lines: [
      { account: "1-1103", pc: "L3", debit: 3_400_000, outlet: "D01" },
      { account: "4-1201", pc: "L3", credit: 3_400_000, outlet: "D01" },
    ],
  },
  {
    key: "store-sales",
    kind: "auto",
    day: 4,
    description: "[Demo] Penjualan toko tunai + HPP",
    sourceType: "pos_sale.recorded",
    lines: [
      { account: "1-1104", pc: "L4", debit: 2_150_000, outlet: "TK1" },
      { account: "4-1301", pc: "L4", credit: 2_150_000, outlet: "TK1" },
      { account: "5-1101", pc: "L4", debit: 1_600_000, outlet: "TK1" },
      { account: "1-1501", pc: "L4", credit: 1_600_000, outlet: "TK1" },
    ],
  },
  {
    key: "water-supply",
    kind: "auto",
    day: 5,
    description: "[Demo] Pasokan air depot D01 (transfer internal L2 → L3)",
    sourceType: "water_supply.confirmed",
    lines: [
      { account: "5-1201", pc: "L3", debit: 900_000, outlet: "D01" },
      { account: "4-1501", pc: "L2", credit: 900_000 },
    ],
  },
  {
    key: "electricity",
    kind: "manual",
    day: 6,
    description: "[Demo] Listrik sumber air (tagihan PLN)",
    sourceType: "manual",
    review: true,
    lines: [
      { account: "5-1401", pc: "L1", debit: 1_800_000 },
      { account: "1-1201", pc: "SHARED", credit: 1_800_000 },
    ],
  },
  {
    key: "bank-deposit",
    kind: "auto",
    day: 7,
    description: "[Demo] Setor kas kantor ke bank",
    sourceType: "bank_deposit.recorded",
    lines: [
      { account: "1-1201", pc: "SHARED", debit: 10_000_000 },
      { account: "1-1101", pc: "SHARED", credit: 10_000_000 },
    ],
  },
];

async function ensureDemoPeriod(
  tx: DbOrTx,
  period: string,
): Promise<string | null> {
  const start = `${period}-01`;
  await tx
    .insert(accountingPeriods)
    .values({
      tenantId: EQUA_TENANT_ID,
      period,
      startDate: start,
      endDate: lastDayOfMonth(start),
      status: "open",
    })
    .onConflictDoNothing();
  const [p] = await tx
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.tenantId, EQUA_TENANT_ID),
        eq(accountingPeriods.period, period),
      ),
    )
    .limit(1);
  return p && (p.status === "open" || p.status === "reopened") ? p.id : null;
}

export async function seedDemoM11Accounting(
  tx: DbOrTx,
  now: Date = new Date(),
  opts: { force?: boolean } = {},
): Promise<{ journals: number }> {
  // Pelengkap bagan akun & pemetaan bawaan SELALU diisi (juga DB uji); data transaksi demo hanya untuk dev/demo.
  await seedM11AccountingDefaults(tx);
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test"))
    return { journals: 0 };
  const today = toBusinessDate(now);
  const period = monthOf(today);
  const periodId = await ensureDemoPeriod(tx, period);
  const finance = userIdByUsername("keuangan1");
  let created = 0;
  if (periodId) {
    const yymm = period.slice(2, 4) + period.slice(5, 7);
    for (const [i, j] of DEMO_JOURNALS.entries()) {
      const id = seedId(`m11:demo_journal:${period}:${j.key}`);
      const [exists] = await tx
        .select({ id: journals.id })
        .from(journals)
        .where(eq(journals.id, id))
        .limit(1);
      if (exists) continue;
      const day = Math.min(j.day, Number(today.slice(8, 10)));
      const date = `${period}-${String(day).padStart(2, "0")}`;
      const total = j.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      // Kepala + baris dalam satu transaksi (penjaga keseimbangan EQ004 diperiksa saat COMMIT).
      await tx.transaction(async (jt) => {
        await jt.insert(journals).values({
          id,
          tenantId: EQUA_TENANT_ID,
          number: `JD-${yymm}-${String(i + 1).padStart(5, "0")}`,
          kind: j.kind,
          status: "posted",
          journalDate:
            date < firstDayOfMonth(today) ? firstDayOfMonth(today) : date,
          periodId,
          description: j.description,
          sourceType: j.sourceType,
          totalDebit: total,
          totalCredit: total,
          requiresOwnerReview: j.review ?? false,
          postedAt: now,
          postedBy: j.kind === "manual" ? finance : null,
          createdBy: j.kind === "manual" ? finance : null,
        });
        await jt.insert(journalLines).values(
          j.lines.map((l, n) => ({
            id: seedId(`m11:demo_journal_line:${period}:${j.key}:${n}`),
            journalId: id,
            lineNo: n + 1,
            accountId: accountId(l.account),
            profitCenter: l.pc,
            outletId: l.outlet ? outletId(l.outlet) : null,
            truckId: l.truck ? truckId(l.truck) : null,
            debit: l.debit ?? 0,
            credit: l.credit ?? 0,
            description: l.memo ?? null,
          })),
        );
      });
      created++;
    }
  }

  await tx
    .insert(recurringJournals)
    .values({
      id: seedId("m11:recurring:rent-office"),
      tenantId: EQUA_TENANT_ID,
      name: "Sewa kantor (aset pribadi disewakan ke PT, K15)",
      template: "rent",
      description: "Sewa kantor bulanan",
      lines: [
        {
          accountId: accountId("6-1201"),
          profitCenter: "SHARED",
          side: "debit",
          amount: 2_500_000,
          memo: "Sewa kantor",
        },
        {
          accountId: accountId("1-1201"),
          profitCenter: "SHARED",
          side: "credit",
          amount: 2_500_000,
          memo: "Transfer bank",
        },
      ],
      dayOfMonth: 1,
      isAccrual: false,
      createdBy: finance,
    })
    .onConflictDoNothing();

  const assets = [
    {
      key: "truck-t1",
      code: "AT-TRK-001",
      name: "Truk tangki T1",
      category: "truck" as const,
      date: "2025-03-01",
      cost: 350_000_000,
      residual: 50_000_000,
      life: 96,
      pc: "L2" as Pc,
      truck: "T1",
      asset: "1-2101",
      acc: "1-2102",
    },
    {
      key: "depot-d01",
      code: "AT-DPT-001",
      name: "Mesin filter & UV depot D01",
      category: "depot_equipment" as const,
      date: "2025-06-10",
      cost: 45_000_000,
      residual: 0,
      life: 60,
      pc: "L3" as Pc,
      outlet: "D01",
      asset: "1-2301",
      acc: "1-2302",
    },
  ];
  for (const a of assets) {
    const id = seedId(`m11:asset:${a.key}`);
    await tx
      .insert(fixedAssets)
      .values({
        id,
        tenantId: EQUA_TENANT_ID,
        code: a.code,
        name: a.name,
        category: a.category,
        acquisitionDate: a.date,
        acquisitionCost: a.cost,
        residualValue: a.residual,
        usefulLifeMonths: a.life,
        profitCenter: a.pc,
        outletId: "outlet" in a && a.outlet ? outletId(a.outlet) : null,
        truckId: "truck" in a && a.truck ? truckId(a.truck) : null,
        assetAccountId: accountId(a.asset),
        accumulatedAccountId: accountId(a.acc),
        expenseAccountId: accountId("6-1501"),
        source: "purchase",
        notes: "Data demo",
        createdBy: finance,
      })
      .onConflictDoNothing();
    await tx
      .insert(fixedAssetExtras)
      .values({ id: seedId(`m11:asset_extra:${a.key}`), fixedAssetId: id })
      .onConflictDoNothing();
  }
  return { journals: created };
}
