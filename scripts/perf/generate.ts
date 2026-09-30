/**
 * `pnpm perf:generate` — pembangkit data sintetis uji beban NFR-05 (3× volume: 20 truk, 30 depot + 50 outlet mitra,
 * 1.000 pelanggan, ±5.000 transaksi/hari) selama 60 hari ke DB PGlite TERPISAH (`.data/pglite-perf`).
 *
 * Metodologi (rinci di docs/qa/uji-beban.md §2):
 * 1. Skema + pengerasan DB (trigger tanpa DELETE, append-only, kolom imutabel, jurnal seimbang, FK tenant) diterapkan
 *    lebih dulu — seluruh data sintetis harus lolos penjaga yang sama dengan produksi.
 * 2. Seed dasar NON-demo, lalu master diperbesar (lib/masters.ts).
 * 3. Transaksi harian ditulis bulk per hari dalam satu transaksi, sudah dalam keadaan akhir yang menjaga invarian
 *    (lib/days.ts). Jurnal M11 memakai MESIN ASLI untuk setiap varian peristiwa lalu direplikasi (lib/journals.ts).
 * 4. Ringkasan H+0 tiap hari lampau diterbitkan lewat LAYANAN M9 (`publishDailySummary`) — angka dihitung ulang dari
 *    data yang dibangkitkan (sekaligus uji konsistensi).
 * 5. Verifikasi invarian (jurnal seimbang, saldo stok = kartu stok, faktur = alokasi, rantai audit utuh) + ANALYZE.
 *
 * Opsi: `--tanggal YYYY-MM-DD` (hari jangkar, bawaan hari ini WIB), `--jam HH:mm` (bawaan 13:30), `--hari N`
 * (bawaan 60), `--benih N` (bawaan 20260930). Data TIDAK memuat nomor WA/alamat nyata (NFR-27).
 */
import { rmSync } from "node:fs";

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";

import { closeDb, getDb, type Db } from "@/db/client";
import { applyDbHardening } from "@/db/hardening";
import * as schema from "@/db/schema";
import { featureFlags } from "@/db/schema";
import { seedId } from "@/db/seed/ids";
import { EQUA_TENANT_ID } from "@/db/seed/org";
import { addDays } from "@/lib/time";
import { ensureBootstrapped } from "@/server/core/bootstrap";
import { verifyAuditChain } from "@/server/core/audit";
import { publishDailySummary } from "@/server/modules/m9-reports/service/h0";

import { anchorFromArgs, assertPerfDir, expectedTransactionsPerDay, numberArg, PERF_DATA_DIR, rng, VOLUME, writeMeta } from "./lib/config";
import { Generator } from "./lib/days";
import { JournalFactory } from "./lib/journals";
import { scaleMasters, seedBase } from "./lib/masters";

function log(message: string): void {
  console.log(`[perf:generate ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  const argv = process.argv.slice(2);
  const { anchorDate, anchorNow } = anchorFromArgs(argv);
  const days = numberArg(argv, "hari", VOLUME.days);
  const seed = numberArg(argv, "benih", 20_260_930);
  assertPerfDir(PERF_DATA_DIR);
  process.env.PGLITE_DATA_DIR = PERF_DATA_DIR;
  process.env.DB_DRIVER = process.env.DB_DRIVER ?? "pglite";
  if (process.env.DB_DRIVER === "pglite") rmSync(PERF_DATA_DIR, { recursive: true, force: true });
  const startDate = addDays(anchorDate, -(days - 1));
  log(`DB ${process.env.DB_DRIVER} ${PERF_DATA_DIR} · ${days} hari ${startDate} … ${anchorDate} (jangkar ${anchorNow.toISOString()}) · ±${expectedTransactionsPerDay()} transaksi/hari`);

  const db = getDb();
  const pushed = await pushSchema(schema as unknown as Record<string, unknown>, db as unknown as Parameters<typeof pushSchema>[1]);
  await pushed.apply();
  await applyDbHardening(db);
  log("skema + pengerasan diterapkan");

  await db.transaction(async (tx) => {
    await seedBase(tx);
    // Runbook cut-over B-84: pemilik menekan "Aktifkan M11" (aktivasi tenant) — jurnal otomatis berjalan.
    await tx
      .insert(featureFlags)
      .values({ id: seedId(`feature_flag:accounting.m11_active:tenant:${EQUA_TENANT_ID}`), key: "accounting.m11_active", scopeType: "tenant", scopeRefId: EQUA_TENANT_ID, enabled: true, reason: "Aktivasi M11 oleh pemilik (uji beban)." })
      .onConflictDoNothing();
  });
  log("seed dasar selesai");

  const world = await db.transaction((tx) => scaleMasters(tx, rng(seed), startDate, anchorDate));
  log(`master: ${world.equaDepots.length} depot EQUA, ${world.partnerOutlets.length} outlet mitra, ${world.trucks.length} truk, ${world.customers.length} pelanggan luar`);

  ensureBootstrapped();
  const jf = new JournalFactory(world.tenantId, world.periods, anchorDate);
  const gen = new Generator(world, jf, seed, startDate, anchorDate, anchorNow);
  for (let i = 0; i < days; i++) {
    const date = addDays(startDate, i);
    const t0 = Date.now();
    await db.transaction((tx) => gen.generateDay(tx, date, i));
    log(`hari ${String(i + 1).padStart(2)}/${days} ${date} · ${((Date.now() - t0) / 1000).toFixed(1)} dtk · POS ${gen.stats.pos_depot ?? 0}+${gen.stats.pos_mitra ?? 0}+${gen.stats.pos_toko ?? 0} · rit ${(gen.stats.rit_pelanggan ?? 0) + (gen.stats.rit_internal ?? 0)} · jurnal templat ${jf.templateCount}/replika ${jf.replicated}`);
  }
  await db.transaction((tx) => gen.finish(tx));
  log(`transaksi selesai (audit ${gen.audit.written} baris)`);

  // H+0 hari lampau lewat layanan M9 (angka dihitung ulang dari data).
  const notes: string[] = [];
  let published = 0;
  for (let i = 0; i < days - 1; i++) {
    const date = addDays(startDate, i);
    try {
      await db.transaction((tx) => publishDailySummary(tx as never, { tenantId: world.tenantId, date, now: new Date(new Date(`${date}T14:55:00Z`).getTime()), trigger: "cash_day_closed" }));
      published++;
    } catch (error) {
      notes.push(`H+0 ${date} gagal: ${(error as Error).message}`);
    }
  }
  log(`H+0 terbit lewat layanan M9: ${published} hari`);

  await verify(db, notes);
  log("ANALYZE …");
  await db.execute(sql`analyze`);

  const counts = await tableCounts(db);
  writeMeta({ generatedAt: new Date().toISOString(), anchorDate, anchorNow: anchorNow.toISOString(), seed, days, durationSec: Math.round((Date.now() - started) / 1000), counts: { ...counts, ...Object.fromEntries(Object.entries(gen.stats).filter(([k]) => !k.startsWith("rows:"))), jurnal_templat: jf.templateCount }, notes });
  console.table(counts);
  if (notes.length) console.warn(notes.join("\n"));
  log(`selesai dalam ${((Date.now() - started) / 60_000).toFixed(1)} menit`);
}

/** Pemeriksaan invarian pasca-pembangkitan (gagal → proses keluar dengan kode 1). */
async function verify(db: Db, notes: string[]): Promise<void> {
  const one = async (label: string, q: ReturnType<typeof sql>) => {
    const res = await db.execute<{ n: string | number }>(q);
    const n = Number(res.rows[0]?.n ?? 0);
    if (n !== 0) notes.push(`INVARIAN GAGAL: ${label} (${n})`);
    log(`invarian ${n === 0 ? "OK   " : "GAGAL"} ${label}`);
  };
  await one("jurnal terposting tidak seimbang", sql`select count(*) as n from (select j.id from journals j join journal_lines l on l.journal_id = j.id where j.status = 'posted' group by j.id, j.total_debit, j.total_credit having sum(l.debit) <> sum(l.credit) or sum(l.debit) <> j.total_debit) x`);
  await one("event keuangan EQUA tanpa jurnal otomatis", sql`select count(*) as n from domain_events e where e.tenant_id = ${EQUA_TENANT_ID} and e.type in ('pos_sale.recorded','deposit.received','collection.recorded') and coalesce((e.payload->>'receivedAmount')::bigint, 1) <> 0 and not exists (select 1 from journals j where j.source_event_id = e.id)`);
  await one("saldo stok ≠ kartu stok", sql`select count(*) as n from stock_balances b where b.quantity <> (select coalesce(sum(quantity), 0) from stock_ledger l where l.outlet_id = b.outlet_id and l.product_id = b.product_id)`);
  await one("sisa faktur ≠ jumlah − alokasi", sql`select count(*) as n from invoices i where i.outstanding_amount <> i.amount - coalesce((select sum(amount) from payment_allocations a where a.invoice_id = i.id), 0)`);
  await one("setoran sopir ≠ Σ tunai rit", sql`select count(*) as n from deposits d where d.source_type = 'driver' and d.expected_cash <> coalesce((select sum(received_amount) from trip_payments p where p.deposit_id = d.id and p.method = 'cash'), 0)`);
  await one("setoran shift ≠ tunai shift", sql`select count(*) as n from deposits d join shifts s on s.id = d.shift_id where d.expected_cash <> coalesce((select sum(total) from pos_sales p where p.shift_id = s.id and p.payment_method = 'cash'), 0)`);
  await one("shift ditutup tanpa setoran (EQUA)", sql`select count(*) as n from shifts s where s.tenant_id = ${EQUA_TENANT_ID} and s.status = 'closed' and s.deposit_id is null`);
  await one("nomor WA pelanggan sintetis tidak berawalan 620000", sql`select count(*) as n from customers where code like 'PLG-1%' and wa_phone not like '620000%'`);
  const chain = await verifyAuditChain(db as never);
  if (!chain.ok) notes.push(`INVARIAN GAGAL: rantai audit rusak di seq ${JSON.stringify(chain)}`);
  log(`invarian ${chain.ok ? "OK   " : "GAGAL"} rantai audit (${chain.checked ?? "?"} baris)`);
}

const COUNT_TABLES = [
  "customers",
  "outlets",
  "trucks",
  "orders",
  "trips",
  "trip_payments",
  "trip_status_events",
  "invoices",
  "payment_allocations",
  "deposits",
  "shifts",
  "pos_sales",
  "pos_sale_lines",
  "stock_ledger",
  "outlet_water_ledger",
  "domain_events",
  "journals",
  "journal_lines",
  "gps_positions",
  "sync_commands",
  "audit_logs",
  "incoming_transfers",
  "daily_summaries",
  "notifications",
] as const;

async function tableCounts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) {
    const res = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${t}"`));
    out[t] = Number(res.rows[0]?.n ?? 0);
  }
  const size = await db.execute<{ s: string }>(sql`select pg_size_pretty(pg_database_size(current_database())) as s`);
  console.log(`Ukuran basis data: ${size.rows[0]?.s}`);
  return out;
}

main()
  .catch((error: unknown) => {
    const e = error as { message?: string; cause?: { message?: string; detail?: string; code?: string } };
    console.error(e.cause ? `Galat DB: ${e.cause.message} ${e.cause.detail ?? ""} (${e.cause.code ?? ""})\nKueri: ${String(e.message).slice(0, 300)}…` : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
