/**
 * Pekerjaan terjadwal (docs/ARCHITECTURE.md §5; D-01): registri job per modul + `runDueJobs(now)` yang dipanggil
 * `/api/cron/tick` (Bearer `CRON_SECRET`) — tiap 5 menit dari GitHub Actions/QStash, harian dari Vercel Cron.
 *
 * Idempoten per SLOT lewat tabel `job_runs` (unik `job_key + run_key`): dua pemicu bersamaan tidak menjalankan job
 * yang sama dua kali; job gagal dicoba ulang pada tick berikutnya (maks. 3 percobaan per slot); job macet > 15 menit
 * dianggap gagal dan boleh diulang.
 *
 * Jadwal (WIB):
 * - `{ kind: "every_5_min" }`                              → slot 5 menit (`2026-09-28T14:35`)
 * - `{ kind: "daily", at: "22:30" }` / `atParam`           → sekali per tanggal bisnis setelah jam itu
 * - `{ kind: "weekly", isoWeekday: 1, at: "07:00" }`       → sekali pada hari itu setelah jam itu (1 = Senin)
 * - `{ kind: "monthly", day: 1, at: "01:00" }`             → sekali per bulan setelah tanggal & jam itu (menyusul
 *                                                            bila tick terlewat)
 *
 * Modul mendaftar dari `registerJobs()`: `registerJob({ key: "m5.credit_hold_daily", schedule, run })`. Job membuka
 * transaksinya sendiri (`withTx`) dan memakai `systemContext({ now })` sebagai pelaku.
 */
import "server-only";

import { and, eq, lt, or, sql } from "drizzle-orm";

import { jobRuns } from "@/db/schema";
import { newId } from "@/lib/ids";
import { parseHourMinute, toWibParts, type HourMinute } from "@/lib/time";

import { ensureBootstrapped } from "./bootstrap";
import { getDb, type Db } from "./db";
import { get as getParam } from "./params-read";
import type { ParamKey } from "./params-registry";

export type JobSchedule =
  | { kind: "every_5_min" }
  | { kind: "daily"; at: HourMinute }
  | { kind: "daily"; atParam: { key: ParamKey; field: string } }
  | { kind: "weekly"; isoWeekday: number; at: HourMinute }
  | { kind: "weekly"; param: { key: ParamKey; weekdayField: string; timeField: string } }
  | { kind: "monthly"; day: number; at: HourMinute };

export type JobContext = {
  now: Date;
  runKey: string;
  db: Db;
};

export type JobDef = {
  key: string;
  description: string;
  schedule: JobSchedule;
  run: (ctx: JobContext) => Promise<unknown>;
};

export type JobRunStatus = "succeeded" | "failed" | "skipped" | "not_due";

export type JobRunResult = {
  key: string;
  runKey: string | null;
  status: JobRunStatus;
  result?: unknown;
  error?: string;
};

const MAX_ATTEMPTS = 3;
const STALE_MS = 15 * 60_000;

const registry = new Map<string, JobDef>();

/** Daftarkan (atau ganti) job. */
export function registerJob(def: JobDef): void {
  if (!/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(def.key)) {
    throw new Error(`Kunci job tidak valid: "${def.key}" (format <modul>.<nama>, huruf kecil).`);
  }
  registry.set(def.key, def);
}

export function unregisterJob(key: string): void {
  registry.delete(key);
}

export function listJobs(): JobDef[] {
  ensureBootstrapped();
  return Array.from(registry.values());
}

export function getJob(key: string): JobDef | undefined {
  ensureBootstrapped();
  return registry.get(key);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

async function resolveTime(db: Db, schedule: JobSchedule, businessDate: string): Promise<{ at?: string; weekday?: number }> {
  if (schedule.kind === "daily" && "atParam" in schedule) {
    const v = (await getParam(db, schedule.atParam.key, businessDate)) as Record<string, unknown>;
    return { at: String(v[schedule.atParam.field]) };
  }
  if (schedule.kind === "weekly" && "param" in schedule) {
    const v = (await getParam(db, schedule.param.key, businessDate)) as Record<string, unknown>;
    return { at: String(v[schedule.param.timeField]), weekday: Number(v[schedule.param.weekdayField]) };
  }
  if (schedule.kind === "daily") return { at: schedule.at };
  if (schedule.kind === "weekly") return { at: schedule.at, weekday: schedule.isoWeekday };
  if (schedule.kind === "monthly") return { at: schedule.at };
  return {};
}

/** Tentukan apakah job jatuh tempo pada `now` dan kunci slotnya. */
export async function resolveSlot(job: JobDef, now: Date, db: Db = getDb()): Promise<{ due: boolean; runKey: string }> {
  const w = toWibParts(now);
  const minutes = w.hour * 60 + w.minute;
  const { at, weekday } = await resolveTime(db, job.schedule, w.businessDate);
  switch (job.schedule.kind) {
    case "every_5_min": {
      const slot = Math.floor(w.minute / 5) * 5;
      return { due: true, runKey: `${w.businessDate}T${pad2(w.hour)}:${pad2(slot)}` };
    }
    case "daily":
      return { due: minutes >= parseHourMinute(at!), runKey: w.businessDate };
    case "weekly": {
      const isoWeekday = w.weekday === 0 ? 7 : w.weekday;
      return { due: isoWeekday === weekday && minutes >= parseHourMinute(at!), runKey: w.businessDate };
    }
    case "monthly": {
      const day = job.schedule.day;
      const due = w.day > day || (w.day === day && minutes >= parseHourMinute(at!));
      return { due, runKey: `${w.year}-${pad2(w.month)}` };
    }
  }
}

/** Klaim slot secara idempoten. Benar bila pemanggil boleh menjalankan job. */
async function claim(db: Db, jobKey: string, runKey: string, now: Date): Promise<boolean> {
  const inserted = await db
    .insert(jobRuns)
    .values({ id: newId(), jobKey, runKey, status: "running", startedAt: now, attempts: 1 })
    .onConflictDoNothing()
    .returning({ id: jobRuns.id });
  if (inserted.length) return true;
  const retried = await db
    .update(jobRuns)
    .set({ status: "running", startedAt: now, finishedAt: null, error: null, attempts: sql`${jobRuns.attempts} + 1` })
    .where(
      and(
        eq(jobRuns.jobKey, jobKey),
        eq(jobRuns.runKey, runKey),
        lt(jobRuns.attempts, MAX_ATTEMPTS),
        or(eq(jobRuns.status, "failed"), and(eq(jobRuns.status, "running"), lt(jobRuns.startedAt, new Date(now.getTime() - STALE_MS)))),
      ),
    )
    .returning({ id: jobRuns.id });
  return retried.length > 0;
}

function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

async function execute(db: Db, job: JobDef, runKey: string, now: Date): Promise<JobRunResult> {
  if (!(await claim(db, job.key, runKey, now))) return { key: job.key, runKey, status: "skipped" };
  try {
    const result = await job.run({ now, runKey, db });
    await db
      .update(jobRuns)
      .set({ status: "succeeded", finishedAt: new Date(), result: toJson(result) })
      .where(and(eq(jobRuns.jobKey, job.key), eq(jobRuns.runKey, runKey)));
    return { key: job.key, runKey, status: "succeeded", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[equa] job ${job.key} (${runKey}) gagal:`, error);
    await db
      .update(jobRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(and(eq(jobRuns.jobKey, job.key), eq(jobRuns.runKey, runKey)));
    return { key: job.key, runKey, status: "failed", error: message };
  }
}

/** Jalankan semua job yang jatuh tempo pada `now` (berurutan). */
export async function runDueJobs(now: Date = new Date(), opts: { only?: readonly string[]; db?: Db } = {}): Promise<JobRunResult[]> {
  ensureBootstrapped();
  const db = opts.db ?? getDb();
  const results: JobRunResult[] = [];
  for (const job of registry.values()) {
    if (opts.only && !opts.only.includes(job.key)) continue;
    let slot: { due: boolean; runKey: string };
    try {
      slot = await resolveSlot(job, now, db);
    } catch (error) {
      results.push({ key: job.key, runKey: null, status: "failed", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!slot.due) {
      results.push({ key: job.key, runKey: slot.runKey, status: "not_due" });
      continue;
    }
    results.push(await execute(db, job, slot.runKey, now));
  }
  return results;
}

/** Jalankan satu job sekarang tanpa melihat jadwal (tetap idempoten per `runKey`, bawaan `manual:<ISO menit>`). */
export async function runJobNow(key: string, now: Date = new Date(), opts: { runKey?: string; db?: Db } = {}): Promise<JobRunResult> {
  ensureBootstrapped();
  const job = registry.get(key);
  if (!job) return { key, runKey: null, status: "failed", error: `Job tidak dikenal: ${key}.` };
  const runKey = opts.runKey ?? `manual:${now.toISOString().slice(0, 16)}`;
  return execute(opts.db ?? getDb(), job, runKey, now);
}
