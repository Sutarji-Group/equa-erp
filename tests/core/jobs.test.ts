import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { GET as cronTick } from "@/app/api/cron/tick/route";
import { jobRuns } from "@/db/schema";
import { listJobs, registerJob, resolveSlot, runDueJobs, runJobNow, unregisterJob, type JobDef } from "@/server/core/jobs";
import { serverEnv } from "@/lib/env";

import { useTestDb } from "../helpers/db";

const at = (iso: string) => new Date(iso);

describe("Pekerjaan terjadwal (jobs.ts, /api/cron/tick)", () => {
  const t = useTestDb({ seed: true });
  const runs: string[] = [];
  let failTimes = 0;

  const every5: JobDef = { key: "uji.every5", description: "uji", schedule: { kind: "every_5_min" }, run: async ({ runKey }) => { runs.push(`e5:${runKey}`); return { ok: true }; } };
  const daily: JobDef = { key: "uji.daily", description: "uji", schedule: { kind: "daily", at: "22:15" }, run: async ({ runKey }) => { runs.push(`d:${runKey}`); } };
  const monthly: JobDef = { key: "uji.monthly", description: "uji", schedule: { kind: "monthly", day: 1, at: "01:00" }, run: async ({ runKey }) => { runs.push(`m:${runKey}`); } };
  const flaky: JobDef = {
    key: "uji.flaky",
    description: "uji",
    schedule: { kind: "daily", at: "00:00" },
    run: async () => {
      if (failTimes-- > 0) throw new Error("gagal sementara");
      runs.push("flaky:ok");
    },
  };
  for (const j of [every5, daily, monthly, flaky]) registerJob(j);
  afterAll(() => {
    for (const j of [every5, daily, monthly, flaky]) unregisterJob(j.key);
  });
  const only = ["uji.every5", "uji.daily", "uji.monthly", "uji.flaky"];

  it("slot WIB: 5 menit, harian setelah jam, bulanan menyusul", async () => {
    expect((await resolveSlot(every5, at("2026-09-28T07:37:00Z"), t.db)).runKey).toBe("2026-09-28T14:35");
    expect(await resolveSlot(daily, at("2026-09-28T15:14:00Z"), t.db)).toEqual({ due: false, runKey: "2026-09-28" });
    expect(await resolveSlot(daily, at("2026-09-28T15:15:00Z"), t.db)).toEqual({ due: true, runKey: "2026-09-28" });
    expect(await resolveSlot(monthly, at("2026-09-30T17:30:00Z"), t.db)).toEqual({ due: false, runKey: "2026-10" });
    expect(await resolveSlot(monthly, at("2026-09-30T18:30:00Z"), t.db)).toEqual({ due: true, runKey: "2026-10" });
    expect((await resolveSlot(monthly, at("2026-10-05T01:00:00Z"), t.db)).due).toBe(true);
  });

  it("idempoten per slot: tick ganda / paralel tidak menjalankan job dua kali", async () => {
    runs.length = 0;
    const now = at("2026-09-28T15:20:00Z"); // 22.20 WIB
    const [a, b] = await Promise.all([runDueJobs(now, { only }), runDueJobs(now, { only })]);
    const c = await runDueJobs(at("2026-09-28T15:21:00Z"), { only });
    expect(runs.filter((r) => r.startsWith("e5:"))).toEqual(["e5:2026-09-28T22:20"]);
    expect(runs.filter((r) => r.startsWith("d:"))).toEqual(["d:2026-09-28"]);
    const statuses = [...a, ...b, ...c].filter((r) => r.key === "uji.daily").map((r) => r.status).sort();
    expect(statuses).toEqual(["skipped", "skipped", "succeeded"]);
    await runDueJobs(at("2026-09-28T15:25:00Z"), { only });
    expect(runs.filter((r) => r.startsWith("e5:"))).toEqual(["e5:2026-09-28T22:20", "e5:2026-09-28T22:25"]);
    const row = await t.db.select().from(jobRuns).where(eq(jobRuns.jobKey, "uji.every5"));
    expect(row.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("job gagal dicoba ulang pada tick berikutnya (maks. 3 percobaan per slot)", async () => {
    failTimes = 5;
    const now = at("2026-09-29T02:00:00Z");
    for (let i = 0; i < 4; i++) await runDueJobs(new Date(now.getTime() + i * 300_000), { only: ["uji.flaky"] });
    const [row] = await t.db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.jobKey, "uji.flaky"), eq(jobRuns.runKey, "2026-09-29")));
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(3);
    failTimes = 0;
    const manual = await runJobNow("uji.flaky", now);
    expect(manual.status).toBe("succeeded");
  });

  it("job inti terdaftar (tenggat persetujuan, push cadangan, ringkasan e-mail PAR-55)", async () => {
    await runDueJobs(at("2026-09-28T00:00:00Z"), { only: [] });
    const keys = listJobs().map((j) => j.key);
    expect(keys).toEqual(expect.arrayContaining(["core.approvals.expire_due", "core.notifications.push_pending", "core.notifications.daily_digest"]));
    const digest = listJobs().find((j) => j.key === "core.notifications.daily_digest")!;
    expect(await resolveSlot(digest, at("2026-09-28T15:29:00Z"), t.db)).toMatchObject({ due: false });
    expect(await resolveSlot(digest, at("2026-09-28T15:30:00Z"), t.db)).toMatchObject({ due: true });
  });

  it("/api/cron/tick menolak tanpa Bearer CRON_SECRET dan menjalankan job bila sah", async () => {
    const denied = await cronTick(new Request("http://x/api/cron/tick"));
    expect(denied.status).toBe(401);
    const ok = await cronTick(
      new Request("http://x/api/cron/tick?only=core.approvals.expire_due", { headers: { authorization: `Bearer ${serverEnv().CRON_SECRET}` } }),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; ran: { key: string; status: string }[] };
    expect(body.ran.map((r) => r.key)).toEqual(["core.approvals.expire_due"]);
    expect(body.ran[0]!.status).toBe("succeeded");
  });
});
