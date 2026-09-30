/**
 * `pnpm perf:measure` — ukur waktu kueri/layanan kunci di atas data uji beban (`pnpm perf:generate`), NFR-03 (web ≤ 2 dtk)
 * dan pull sinkron ≤ 2 dtk. Semua kasus memanggil LAYANAN yang sama dengan halaman/route handler (otorisasi, validasi,
 * kueri), bukan kueri tiruan. Lapangan lewat jalur perangkat sungguhan: aktivasi → login PIN → `processPull` /
 * `processPush` (tanda tangan perintah, sesi, handler sinkron, event, jurnal M11).
 *
 * Keluaran: tabel (min / median / maks, jumlah kueri SQL per panggilan, ukuran respons JSON & gzip) + berkas JSON
 * `.data/perf-hasil-<label>.json`. Metodologi & tafsiran: docs/qa/uji-beban.md.
 *
 * Opsi: `--label sebelum|sesudah` (nama berkas hasil), `--ulang N` (bawaan 5), `--kasus a,b` (subset), `--profil`
 * (cetak 5 kueri terlama per kasus — perkiraan dari jeda antar-kueri), `--keluaran DIR` (simpan keluaran tiap kasus
 * sebagai `DIR/<kasus>.json` — bandingkan sebelum/sesudah perbaikan untuk membuktikan perilaku tidak berubah).
 *
 * DB lain (mis. cabang Neon staging berisi data `DB_DRIVER=neon pnpm perf:generate`): `DB_DRIVER=neon|pg` +
 * `DATABASE_URL`; nama basis data WAJIB memuat "perf" (push uji menulis data). Waktu yang terukur kemudian sudah
 * termasuk latensi jaringan per kueri (lihat docs/qa/uji-beban.md §6).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { PGlite } from "@electric-sql/pglite";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { Logger } from "drizzle-orm/logger";
import pg from "pg";
import ws from "ws";

import { setDbForTests, type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { accounts, posSales, shifts, trips } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, truckId } from "@/db/seed/org";
import { productId } from "@/db/seed/catalog";
import { newId } from "@/lib/ids";
import { addDays, monthOf, toBusinessDate } from "@/lib/time";
import { queryForActor } from "@/server/core/audit";
import { ensureBootstrapped } from "@/server/core/bootstrap";
import type { PullResponse } from "@/server/core/sync";
import * as m2 from "@/server/modules/m2-orders";
import * as m3 from "@/server/modules/m3-driver";
import * as m4 from "@/server/modules/m4-cash";
import * as m5 from "@/server/modules/m5-receivables";
import * as m9 from "@/server/modules/m9-reports";
import * as m11 from "@/server/modules/m11-accounting";
import * as m12 from "@/server/modules/m12-fleet";

import { seededContext } from "../../tests/helpers/context";
import { fieldDevice, type FieldDevice } from "../../tests/helpers/field";
import { numberArg, PERF_DATA_DIR, readMeta } from "./lib/config";

type Sample = { ms: number; queries: number; bytes: number; gzip: number };
type CaseResult = {
  key: string;
  label: string;
  kind: "web" | "pull" | "push";
  targetMs: number;
  samples: Sample[];
  min: number;
  median: number;
  max: number;
  queries: number;
  bytes: number;
  gzip: number;
  pass: boolean;
  note?: string;
  slowest?: { ms: number; sql: string }[];
  repeated?: { count: number; sql: string }[];
};

/** Pencatat kueri Drizzle: jumlah + perkiraan durasi per kueri (jeda ke kueri berikutnya / akhir kasus). */
class QueryLog implements Logger {
  entries: { t: number; sql: string }[] = [];
  logQuery(query: string): void {
    this.entries.push({ t: performance.now(), sql: query });
  }
  reset(): void {
    this.entries = [];
  }
  slowest(end: number, n = 5): { ms: number; sql: string }[] {
    return this.entries
      .map((e, i) => ({ ms: Math.round(((this.entries[i + 1]?.t ?? end) - e.t) * 10) / 10, sql: e.sql.replace(/\s+/g, " ").slice(0, process.env.PERF_SQL_LEN ? Number(process.env.PERF_SQL_LEN) : 220) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, n);
  }
  /** Kueri yang paling sering berulang dalam satu panggilan (petunjuk N+1): teks SQL identik → jumlah. */
  repeated(n = 5): { count: number; sql: string }[] {
    const counts = new Map<string, number>();
    for (const e of this.entries) {
      const key = e.sql.replace(/\s+/g, " ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([sql, count]) => ({ count, sql: sql.slice(0, process.env.PERF_SQL_LEN ? Number(process.env.PERF_SQL_LEN) : 220) }));
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** DB uji beban: PGlite berkas (bawaan) atau Postgres/Neon lewat `DB_DRIVER` + `DATABASE_URL` (nama DB memuat "perf"). */
function openDb(logger: Logger): { db: Db; close: () => Promise<void>; target: string } {
  const driver = process.env.DB_DRIVER?.trim() || "pglite";
  if (driver === "pglite") {
    const client = new PGlite(PERF_DATA_DIR);
    return { db: drizzlePglite({ client, schema, logger }) as unknown as Db, close: () => client.close(), target: PERF_DATA_DIR };
  }
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const dbName = url ? new URL(url).pathname.replace(/^\//, "") : "";
  if (!dbName.includes("perf")) throw new Error(`DB_DRIVER=${driver}: DATABASE_URL harus menunjuk basis data uji beban (nama memuat "perf"), bukan "${dbName || "(kosong)"}".`);
  if (driver === "neon") {
    neonConfig.webSocketConstructor = ws;
    const pool = new NeonPool({ connectionString: url });
    return { db: drizzleNeon({ client: pool, schema, logger }) as unknown as Db, close: () => pool.end(), target: `neon:${dbName}` };
  }
  if (driver === "pg") {
    const pool = new pg.Pool({ connectionString: url });
    return { db: drizzleNodePg({ client: pool, schema, logger }) as unknown as Db, close: () => pool.end(), target: `pg:${dbName}` };
  }
  throw new Error(`DB_DRIVER tidak dikenal: "${driver}". Gunakan pglite, neon, atau pg.`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function main(): Promise<void> {
  const meta = readMeta();
  const label = arg("label") ?? "hasil";
  const repeat = numberArg(process.argv, "ulang", 5);
  const only = arg("kasus")?.split(",");
  const profile = process.argv.includes("--profil");
  const outputDir = arg("keluaran");
  if (outputDir) mkdirSync(outputDir, { recursive: true });
  const now = new Date(meta.anchorNow);
  const today = meta.anchorDate;
  const yesterday = addDays(today, -1);
  const month = monthOf(today);

  const log = new QueryLog();
  const { db, close, target } = openDb(log);
  setDbForTests(db);
  ensureBootstrapped();
  console.log(`perf:measure → ${target} · jangkar ${today} ${now.toISOString()} · ${repeat}× per kasus`);

  const owner = seededContext("pemilik", { now });
  const finance = seededContext("keuangan1", { now });
  const dispatcher = seededContext("dispatcher1", { now });
  const accountant = seededContext("akuntan", { now });
  const acc = async (code: string) => (await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.tenantId, EQUA_TENANT_ID), eq(accounts.code, code))).limit(1))[0]!.id;
  const kasDepot = await acc("1-1103");
  const pendapatanDepot = await acc("4-1201");
  const t3 = truckId("T3");

  // --- Perangkat lapangan (jalur perangkat sungguhan) -------------------------------------------------------------
  let hp: FieldDevice | null = null;
  let pos: FieldDevice | null = null;
  let driverSession: { sessionId: string } | null = null;
  let posSession: { sessionId: string; user: { id: string } } | null = null;
  // POS-D06: shift terbuka ukuran wajar (±70 transaksi). POS-D05 menerima push uji sehingga shift-nya terus membesar
  // (+50 transaksi per putaran push) — pull D05 memperlihatkan pertumbuhan muatan per transaksi shift (lihat uji-beban.md).
  let pos6: FieldDevice | null = null;
  let pos6Session: { sessionId: string; user: { id: string } } | null = null;
  const field = async () => {
    if (hp && pos && driverSession && posSession && pos6 && pos6Session) return;
    hp = await fieldDevice("HP-T3", { admin: seededContext("admin1", { now }) });
    driverSession = await hp.login("sopir3", { now });
    pos = await fieldDevice("POS-D05", { admin: seededContext("admin1", { now }) });
    posSession = (await pos.login("depot05", { now })) as unknown as { sessionId: string; user: { id: string } };
    pos6 = await fieldDevice("POS-D06", { admin: seededContext("admin1", { now }) });
    pos6Session = (await pos6.login("depot06", { now })) as unknown as { sessionId: string; user: { id: string } };
  };

  type Def = { key: string; label: string; kind: CaseResult["kind"]; targetMs: number; run: () => Promise<unknown>; setup?: () => Promise<void> };
  // Pull bersyarat v2: kursor per perangkat (diperbarui dari respons, seperti klien).
  const v2: { sopir: Record<string, string>; pos6: Record<string, string>; pos5: Record<string, string> } = { sopir: {}, pos6: {}, pos5: {} };
  const cursorsOf = (res: PullResponse, prev: Record<string, string>): Record<string, string> => ({ ...prev, ...(res.cursors ?? {}) });
  let correctionRound = 0;
  /** Push `n` transaksi tunai ke shift terbuka outlet (nomor lokal lanjut dari urutan perangkat). */
  const pushSales = async (fd: FieldDevice, session: { sessionId: string; user: { id: string } }, code: string, n: number) => {
    const [open] = await db.select().from(shifts).where(and(eq(shifts.outletId, outletId(code)), eq(shifts.status, "open"))).limit(1);
    if (!open) throw new Error(`Shift ${code} hari jangkar tidak terbuka — bangkitkan ulang data.`);
    const [last] = await db.select({ seq: posSales.deviceSeq }).from(posSales).where(eq(posSales.deviceId, open.deviceId!)).orderBy(desc(posSales.deviceSeq)).limit(1);
    let seq = last?.seq ?? 0;
    const yymmdd = today.slice(2).replace(/-/g, "");
    const commands = Array.from({ length: n }, (_, i) => {
      seq++;
      const deviceTime = new Date(now.getTime() - (n - i) * 1_000);
      return fd.command(session, "m6.pos_sale.create", { saleId: newId(), shiftId: open.id, localNumber: `${code}-${yymmdd}-POS-${code}-${String(seq).padStart(4, "0")}`, deviceSeq: seq, lines: [{ productId: productId("ISI-ULANG"), quantity: 1, unitPrice: 5_000 }], paymentMethod: "cash", cashReceived: 5_000 }, { deviceTime, businessDate: toBusinessDate(deviceTime) });
    });
    const res = await fd.push(commands, { now });
    const bad = res.results.filter((r) => r.status !== "applied");
    if (bad.length) throw new Error(`Push ${code}: ${bad.length} perintah tidak diterapkan — ${JSON.stringify(bad[0])}`);
  };
  let pushRound = 0;
  let kasLastOffset = 0;
  const ledgerPage = (accountId: string, offset: number) => m11.getLedger(accountant, { accountId, fromPeriod: month, offset, limit: m11.LEDGER_PAGE_SIZE });
  const defs: Def[] = [
    { key: "m4.kas_hari_ini", label: "M4 Kas hari ini (getCashPosition)", kind: "web", targetMs: 2_000, run: () => m4.getCashPosition(finance, { date: today }) },
    { key: "m2.papan_jadwal", label: "M2 Papan jadwal per tanggal (getBoard)", kind: "web", targetMs: 2_000, run: () => m2.getBoard(dispatcher, today) },
    { key: "m9.h0_hari_ini", label: "M9 Dashboard H+0 hari ini (berjalan)", kind: "web", targetMs: 2_000, run: () => m9.getDailyDashboard(owner, { range: "today" }) },
    { key: "m9.h0_kemarin", label: "M9 Dashboard H+0 kemarin (terbit)", kind: "web", targetMs: 2_000, run: () => m9.getDailyDashboard(owner, { range: "yesterday" }) },
    { key: "m9.h0_bulan", label: "M9 Dashboard rentang bulan berjalan", kind: "web", targetMs: 2_000, run: () => m9.getDailyDashboard(owner, { range: "month" }) },
    { key: "m9.bulanan", label: "M9 Laporan laba kotor bulanan", kind: "web", targetMs: 2_000, run: () => m9.getMonthlyReport(owner, { month }) },
    { key: "m5.umur_piutang", label: "M5 Umur piutang (agingReport)", kind: "web", targetMs: 2_000, run: () => m5.agingReport(finance, { asOf: today }) },
    { key: "m12.posisi_terakhir", label: "M12 Peta — posisi GPS terakhir (getFleetSnapshot)", kind: "web", targetMs: 2_000, run: () => m12.getFleetSnapshot(dispatcher, {}) },
    { key: "m12.riwayat_hari", label: "M12 Riwayat hari semua truk (listTruckDays kemarin)", kind: "web", targetMs: 2_000, run: () => m12.listTruckDays(dispatcher, { date: yesterday }) },
    { key: "m12.riwayat_truk", label: "M12 Rincian truk-hari (getTruckDay T3 kemarin)", kind: "web", targetMs: 2_000, run: () => m12.getTruckDay(dispatcher, { truckId: t3, date: yesterday }) },
    // Halaman buku besar: halaman pertama (`?hal=` bawaan) & halaman terakhir (saldo berjalan diteruskan dari baris sebelumnya).
    { key: "m11.buku_besar_kas", label: "M11 Buku besar Kas outlet depot (bulan berjalan, halaman 1)", kind: "web", targetMs: 2_000, run: () => ledgerPage(kasDepot, 0) },
    { key: "m11.buku_besar_kas_akhir", label: "M11 Buku besar Kas outlet depot (halaman terakhir)", kind: "web", targetMs: 2_000, setup: async () => {
        const first = await ledgerPage(kasDepot, 0);
        kasLastOffset = Math.max(0, Math.floor((first.page.total - 1) / m11.LEDGER_PAGE_SIZE) * m11.LEDGER_PAGE_SIZE);
      }, run: () => ledgerPage(kasDepot, kasLastOffset) },
    { key: "m11.buku_besar_pendapatan", label: "M11 Buku besar Pendapatan depot (bulan berjalan, halaman 1)", kind: "web", targetMs: 2_000, run: () => ledgerPage(pendapatanDepot, 0) },
    { key: "m11.buku_besar_ekspor", label: "M11 Buku besar Kas — data ekspor (maks. LEDGER_MAX_ROWS baris)", kind: "web", targetMs: 10_000, run: () => m11.getLedger(accountant, { accountId: kasDepot, fromPeriod: month, limit: m11.LEDGER_MAX_ROWS }) },
    { key: "m11.laba_rugi", label: "M11 Laporan keuangan + laba rugi per lini (getStatements)", kind: "web", targetMs: 2_000, run: () => m11.getStatements(accountant, { period: month }) },
    { key: "m2.daftar_pesanan", label: "M2 Daftar pesanan (listOrders bawaan)", kind: "web", targetMs: 2_000, run: () => m2.listOrders(dispatcher, {}) },
    { key: "m4.daftar_setoran", label: "M4 Daftar setoran hari ini (listDeposits)", kind: "web", targetMs: 2_000, run: () => m4.listDeposits(finance, {}) },
    { key: "m5.daftar_faktur", label: "M5 Faktur belum lunas (listInvoices)", kind: "web", targetMs: 2_000, run: () => m5.listInvoices(finance, { status: "unpaid" }) },
    { key: "m11.daftar_jurnal", label: "M11 Daftar jurnal periode berjalan (listJournals)", kind: "web", targetMs: 2_000, run: () => m11.listJournals(accountant, { period: month }) },
    { key: "m10.jejak_audit", label: "M10 Jejak audit terbaru (queryForActor)", kind: "web", targetMs: 2_000, run: () => queryForActor(owner, {}) },
    {
      key: "sync.pull_sopir",
      label: "Pull sinkron sopir (HP-T3, semua penyedia)",
      kind: "pull",
      targetMs: 2_000,
      setup: field,
      run: () => hp!.pull(driverSession!, {}, { now }),
    },
    {
      key: "sync.pull_pos",
      label: "Pull sinkron POS depot (POS-D05, semua penyedia)",
      kind: "pull",
      targetMs: 2_000,
      setup: field,
      run: () => pos!.pull(posSession!, {}, { now }),
    },
    {
      key: "sync.pull_pos_d06",
      label: "Pull sinkron POS depot (POS-D06, shift ±70 transaksi)",
      kind: "pull",
      targetMs: 2_000,
      setup: field,
      run: () => pos6!.pull(pos6Session!, {}, { now }),
    },
    {
      key: "sync.pull_sopir_delta",
      label: "Pull sinkron sopir — delta (since = kursor terakhir, tanpa perubahan)",
      kind: "pull",
      targetMs: 2_000,
      setup: field,
      run: () => hp!.pull(driverSession!, { since: now.toISOString() }, { now }),
    },
    {
      key: "sync.pull_pos_delta",
      label: "Pull sinkron POS — delta (since = kursor terakhir, tanpa perubahan)",
      kind: "pull",
      targetMs: 2_000,
      setup: field,
      run: () => pos!.pull(posSession!, { since: now.toISOString() }, { now }),
    },
    {
      key: "sync.pull_pos_d06_delta",
      label: "Pull sinkron POS-D06 — delta (since = kursor terakhir, tanpa perubahan)",
      kind: "pull",
      targetMs: 2_000,
      setup: field,
      run: () => pos6!.pull(pos6Session!, { since: now.toISOString() }, { now }),
    },
    // --- Pull bersyarat v1.0.1 (D-14 butir 3, B-89): kursor sidik-isi per penyedia (`?v=2&c.<kunci>=…`) -------------
    {
      key: "sync.pull_sopir_v2_sama",
      label: "Pull sopir v2 — kursor terbaru, tanpa perubahan (semua penyedia 'tidak berubah')",
      kind: "pull",
      targetMs: 2_000,
      setup: async () => {
        await field();
        v2.sopir = cursorsOf(await hp!.pull(driverSession!, { cursors: {} }, { now }), {});
      },
      run: () => hp!.pull(driverSession!, { cursors: v2.sopir }, { now }),
    },
    {
      key: "sync.pull_sopir_v2_koreksi",
      label: "Pull sopir v2 setelah koreksi kantor 1 rit Selesai (koreksi harga + pull delta)",
      kind: "pull",
      targetMs: 2_000,
      setup: async () => {
        await field();
        v2.sopir = cursorsOf(await hp!.pull(driverSession!, { cursors: {} }, { now }), {});
      },
      run: async () => {
        const [trip] = await db
          .select({ id: trips.id, price: trips.price })
          .from(trips)
          .where(and(eq(trips.truckId, t3), eq(trips.scheduledDate, today), eq(trips.status, "completed"), eq(trips.isInternal, false)))
          .limit(1);
        if (!trip) throw new Error("Tidak ada rit Selesai T3 pada hari jangkar.");
        correctionRound++;
        await m3.correctTrip(finance, { tripId: trip.id, price: trip.price + (correctionRound % 2 ? 1_000 : -1_000), reason: `Uji beban v1.0.1 — koreksi harga ke-${correctionRound}` });
        const res = await hp!.pull(driverSession!, { cursors: v2.sopir }, { now });
        v2.sopir = cursorsOf(res, v2.sopir);
        return res;
      },
    },
    {
      key: "sync.pull_pos_d06_v2_sama",
      label: "Pull POS-D06 v2 — kursor terbaru, tanpa perubahan",
      kind: "pull",
      targetMs: 2_000,
      setup: async () => {
        await field();
        v2.pos6 = cursorsOf(await pos6!.pull(pos6Session!, { cursors: {} }, { now }), {});
      },
      run: () => pos6!.pull(pos6Session!, { cursors: v2.pos6 }, { now }),
    },
    {
      key: "sync.pull_pos_d06_v2_1trx",
      label: "Pull POS-D06 v2 setelah 1 transaksi baru (push 1 + pull delta)",
      kind: "pull",
      targetMs: 2_000,
      setup: async () => {
        await field();
        v2.pos6 = cursorsOf(await pos6!.pull(pos6Session!, { cursors: {} }, { now }), {});
      },
      run: async () => {
        await pushSales(pos6!, pos6Session!, "D06", 1);
        const res = await pos6!.pull(pos6Session!, { cursors: v2.pos6 }, { now });
        v2.pos6 = cursorsOf(res, v2.pos6);
        return res;
      },
    },
    {
      key: "sync.pull_pos_d05_v2_1trx",
      label: "Pull POS-D05 v2 (shift besar) setelah 1 transaksi baru (push 1 + pull delta)",
      kind: "pull",
      targetMs: 2_000,
      setup: async () => {
        await field();
        v2.pos5 = cursorsOf(await pos!.pull(posSession!, { cursors: {} }, { now }), {});
      },
      run: async () => {
        await pushSales(pos!, posSession!, "D05", 1);
        const res = await pos!.pull(posSession!, { cursors: v2.pos5 }, { now });
        v2.pos5 = cursorsOf(res, v2.pos5);
        return res;
      },
    },
    {
      key: "sync.push_50",
      label: "Push batch 50 transaksi POS (POS-D05)",
      kind: "push",
      targetMs: 10_000,
      setup: field,
      run: async () => {
        pushRound++;
        const [open] = await db.select().from(shifts).where(and(eq(shifts.outletId, outletId("D05")), eq(shifts.status, "open"))).limit(1);
        if (!open) throw new Error("Shift D05 hari jangkar tidak terbuka — bangkitkan ulang data.");
        const [last] = await db.select({ seq: posSales.deviceSeq }).from(posSales).where(eq(posSales.deviceId, open.deviceId!)).orderBy(desc(posSales.deviceSeq)).limit(1);
        let seq = last?.seq ?? 0;
        const yymmdd = today.slice(2).replace(/-/g, "");
        const commands = Array.from({ length: 50 }, (_, i) => {
          seq++;
          const qty = 1 + (i % 3);
          const deviceTime = new Date(now.getTime() - (50 - i) * 1_000 - pushRound * 60_000);
          return pos!.command(posSession!, "m6.pos_sale.create", { saleId: newId(), shiftId: open.id, localNumber: `D05-${yymmdd}-POS-D05-${String(seq).padStart(4, "0")}`, deviceSeq: seq, lines: [{ productId: productId("ISI-ULANG"), quantity: qty, unitPrice: 5_000 }], paymentMethod: i % 4 === 0 ? "qris" : "cash", cashReceived: i % 4 === 0 ? null : qty * 5_000 }, { deviceTime, businessDate: toBusinessDate(deviceTime) });
        });
        const res = await pos!.push(commands, { now });
        const bad = res.results.filter((r) => r.status !== "applied");
        if (bad.length) throw new Error(`Push: ${bad.length} perintah tidak diterapkan — ${JSON.stringify(bad[0])}`);
        return res;
      },
    },
  ];

  const results: CaseResult[] = [];
  for (const d of defs) {
    if (only && !only.includes(d.key)) continue;
    try {
      await d.setup?.();
      await d.run(); // pemanasan (cache rencana kueri & modul)
      const samples: Sample[] = [];
      let slowest: CaseResult["slowest"];
      let repeated: CaseResult["repeated"];
      for (let i = 0; i < repeat; i++) {
        log.reset();
        const t0 = performance.now();
        const out = await d.run();
        const t1 = performance.now();
        const json = JSON.stringify(out) ?? "";
        samples.push({ ms: Math.round((t1 - t0) * 10) / 10, queries: log.entries.length, bytes: Buffer.byteLength(json), gzip: gzipSync(json).length });
        if (profile && i === repeat - 1) {
          slowest = log.slowest(t1);
          repeated = log.repeated();
        }
        if (outputDir && i === repeat - 1) writeFileSync(`${outputDir}/${d.key}.json`, `${JSON.stringify(out, null, 1)}\n`);
      }
      const ms = samples.map((s) => s.ms);
      const r: CaseResult = {
        key: d.key,
        label: d.label,
        kind: d.kind,
        targetMs: d.targetMs,
        samples,
        min: Math.min(...ms),
        median: median(ms),
        max: Math.max(...ms),
        queries: median(samples.map((s) => s.queries)),
        bytes: median(samples.map((s) => s.bytes)),
        gzip: median(samples.map((s) => s.gzip)),
        pass: median(ms) <= d.targetMs,
        slowest,
        repeated,
      };
      results.push(r);
      console.log(`${r.pass ? "LULUS" : "GAGAL"} ${d.key.padEnd(26)} median ${String(r.median).padStart(8)} ms · min ${r.min} · maks ${r.max} · ${r.queries} kueri · ${(r.bytes / 1024).toFixed(1)} KB (gzip ${(r.gzip / 1024).toFixed(1)} KB)`);
      if (slowest) for (const s of slowest) console.log(`      ${String(s.ms).padStart(8)} ms  ${s.sql}`);
      if (repeated?.length) for (const q of repeated) console.log(`      ${String(q.count).padStart(6)} ×    ${q.sql}`);
    } catch (error) {
      console.error(`GALAT ${d.key}: ${(error as Error).message}`);
      results.push({ key: d.key, label: d.label, kind: d.kind, targetMs: d.targetMs, samples: [], min: 0, median: 0, max: 0, queries: 0, bytes: 0, gzip: 0, pass: false, note: (error as Error).message });
    }
  }

  const counts = await db.execute<{ t: string; n: number }>(sql`select 'pos_sales' as t, count(*)::int as n from pos_sales union all select 'journal_lines', count(*)::int from journal_lines union all select 'gps_positions', count(*)::int from gps_positions union all select 'trips', count(*)::int from trips`);
  const file = `.data/perf-hasil-${label}.json`;
  writeFileSync(file, `${JSON.stringify({ label, measuredAt: new Date().toISOString(), anchor: meta.anchorDate, repeat, counts: counts.rows, results }, null, 2)}\n`);
  console.log(`Hasil: ${file} · ${results.filter((r) => r.pass).length}/${results.length} lulus`);
  await close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
