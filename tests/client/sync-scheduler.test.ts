import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUSY_SYNC_INTERVAL_MS,
  createSyncScheduler,
  IDLE_PULL_INTERVAL_MS,
  idleIntervalFor,
  VISIBLE_PULL_MIN_GAP_MS,
  type PullMode,
  type SyncTrigger,
} from "@/client/offline/scheduler";

type Call = { trigger: SyncTrigger; pull: PullMode; at: number };

/** Penjadwal dengan dependensi tiruan & waktu palsu Vitest. */
function harness(opts: { pending?: number; visible?: boolean; idleMs?: number; runMs?: number } = {}) {
  const state = { pending: opts.pending ?? 0, visible: opts.visible ?? true, lastPullAt: null as number | null };
  const calls: Call[] = [];
  const scheduler = createSyncScheduler({
    run: async ({ trigger, pull }) => {
      calls.push({ trigger, pull, at: Date.now() });
      if (opts.runMs) await new Promise((r) => setTimeout(r, opts.runMs));
      if (pull === true) state.lastPullAt = Date.now();
    },
    pendingCount: async () => state.pending,
    lastPullAt: async () => state.lastPullAt,
    idleIntervalMs: () => opts.idleMs ?? IDLE_PULL_INTERVAL_MS,
    isVisible: () => state.visible,
  });
  return { state, calls, scheduler };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("Penjadwal sinkron latar adaptif (B-88, D-14 butir 2, PAR-30)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T01:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("B-88 US-M3-09 KP-2 jeda pull latar = min(5 menit, PAR-30), tidak pernah lebih jarang dari PAR-30; push saat ada antrean 60 dtk", () => {
    expect(IDLE_PULL_INTERVAL_MS).toBe(5 * 60_000);
    expect(BUSY_SYNC_INTERVAL_MS).toBe(60_000);
    expect(idleIntervalFor(5)).toBe(5 * 60_000);
    expect(idleIntervalFor(10)).toBe(5 * 60_000); // D-14: tiap 5 menit walau PAR-30 lebih longgar
    expect(idleIntervalFor(3)).toBe(3 * 60_000); // PAR-30 lebih ketat → diikuti
    expect(idleIntervalFor(0.5)).toBe(60_000); // batas bawah = jeda sibuk
    expect(idleIntervalFor(null)).toBe(5 * 60_000);
  });

  it("B-88 antrean kosong → satu putaran saat mulai, lalu pull latar tiap 5 menit (bukan 60 dtk)", async () => {
    const h = harness();
    h.scheduler.start();
    await advance(0);
    expect(h.calls).toEqual([{ trigger: "start", pull: true, at: Date.now() }]);
    expect(h.scheduler.currentDelay()).toBe(5 * 60_000);
    await advance(4 * 60_000 + 59_000);
    expect(h.calls).toHaveLength(1);
    await advance(1_000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ trigger: "timer", pull: "auto" });
    await advance(5 * 60_000);
    expect(h.calls).toHaveLength(3);
    // Satu jam = 12 putaran latar (sebelumnya 60).
    await advance(60 * 60_000);
    expect(h.calls.filter((c) => c.trigger === "timer")).toHaveLength(14);
    h.scheduler.stop();
  });

  it("B-88 ada antrean → putaran tiap 60 dtk (push/coba ulang); antrean habis → kembali 5 menit", async () => {
    const h = harness({ pending: 2 });
    h.scheduler.start();
    await advance(0);
    expect(h.scheduler.currentDelay()).toBe(60_000);
    await advance(60_000);
    expect(h.calls.map((c) => c.trigger)).toEqual(["start", "timer"]);
    h.state.pending = 0; // terkirim
    await advance(60_000);
    expect(h.calls).toHaveLength(3);
    expect(h.scheduler.currentDelay()).toBe(5 * 60_000);
    await advance(4 * 60_000);
    expect(h.calls).toHaveLength(3);
    h.scheduler.stop();
  });

  it("B-88 perubahan antrean → push segera (debounce 500 ms) dengan pull 'auto' (pull setelah push berhasil) dan jeda 5 menit diatur ulang", async () => {
    const h = harness();
    h.scheduler.start();
    await advance(0);
    await advance(2 * 60_000);
    h.state.pending = 1;
    h.scheduler.trigger("outbox");
    h.scheduler.trigger("outbox"); // beberapa enqueue beruntun → satu putaran
    await advance(499);
    expect(h.calls).toHaveLength(1);
    await advance(1);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ trigger: "outbox", pull: "auto" });
    h.state.pending = 0;
    await advance(60_000); // putaran sibuk berikutnya (antrean sempat berisi)
    expect(h.calls).toHaveLength(3);
    expect(h.scheduler.currentDelay()).toBe(5 * 60_000);
    h.scheduler.stop();
  });

  it("B-88 kembali online → segera dengan pull; kembali terlihat → segera, pull bila pull terakhir > 60 dtk (berpindah aplikasi berkali-kali tidak menarik ulang)", async () => {
    const h = harness();
    h.scheduler.start();
    await advance(0);
    h.scheduler.trigger("online");
    await advance(0);
    expect(h.calls[1]).toMatchObject({ trigger: "online", pull: true });
    await advance(10_000);
    h.scheduler.trigger("visible");
    await advance(0);
    expect(h.calls[2]).toMatchObject({ trigger: "visible", pull: "auto" }); // < 60 dtk sejak pull terakhir
    await advance(VISIBLE_PULL_MIN_GAP_MS);
    h.scheduler.trigger("visible");
    await advance(0);
    expect(h.calls[3]).toMatchObject({ trigger: "visible", pull: true });
    h.scheduler.stop();
  });

  it("B-88 NFR-17 aplikasi tidak terlihat & antrean kosong → putaran latar dilewati tanpa jaringan; ada antrean → tetap push", async () => {
    const h = harness({ visible: false });
    h.scheduler.start();
    await advance(0);
    await advance(30 * 60_000);
    expect(h.calls.map((c) => c.trigger)).toEqual(["start"]);
    h.state.pending = 1;
    await advance(5 * 60_000);
    expect(h.calls.map((c) => c.trigger)).toEqual(["start", "timer"]);
    h.state.pending = 0;
    h.state.visible = true;
    h.scheduler.trigger("visible");
    await advance(0);
    expect(h.calls[2]).toMatchObject({ trigger: "visible", pull: true });
    h.scheduler.stop();
  });

  it("B-88 pemicu saat putaran masih berjalan tidak hilang → satu putaran lagi segera setelahnya (pull terkuat dipakai)", async () => {
    const h = harness({ runMs: 2_000 });
    h.scheduler.start();
    await advance(500);
    h.scheduler.trigger("online");
    h.scheduler.trigger("outbox");
    await advance(600); // debounce outbox selesai saat putaran awal masih berjalan
    expect(h.calls).toHaveLength(1);
    await advance(2_000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ trigger: "online", pull: true });
    await advance(2_000);
    expect(h.calls).toHaveLength(2); // tidak berulang tanpa henti
    h.scheduler.stop();
  });

  it("B-88 galat putaran tidak menghentikan jadwal; stop() membersihkan timer", async () => {
    let n = 0;
    const scheduler = createSyncScheduler({
      run: async () => {
        n++;
        throw new Error("server 500");
      },
      pendingCount: async () => 0,
      lastPullAt: async () => null,
      idleIntervalMs: () => 60_000,
    });
    scheduler.start();
    await advance(0);
    await advance(60_000);
    expect(n).toBe(2);
    scheduler.stop();
    await advance(10 * 60_000);
    expect(n).toBe(2);
    expect(scheduler.currentDelay()).toBeNull();
  });
});
