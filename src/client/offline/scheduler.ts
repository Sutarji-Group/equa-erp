/**
 * Penjadwal sinkron latar aplikasi lapangan (D-14 butir 2, NFR-17 kuota; PAR-30 "sinkron ≤ 5 menit").
 *
 * Aturan:
 * - **Antrean kosong** → putaran berikutnya `idleIntervalMs` (bawaan 5 menit, tidak pernah melebihi PAR-30) — pull
 *   latar saja. Saat aplikasi tidak terlihat (layar mati / aplikasi lain di depan) putaran idle DILEWATI tanpa
 *   jaringan; begitu aplikasi terlihat lagi, pull segera.
 * - **Ada antrean** (termasuk menunggu coba ulang) → putaran berikutnya `busyIntervalMs` (60 dtk) untuk push; pull
 *   mengikuti push yang berhasil (keputusan `pull: "auto"` di `syncNow`).
 * - **Perubahan antrean** (`enqueue`) → push segera (debounce 500 ms), lalu pull bila push berhasil.
 * - **Permintaan eksplisit** (login PIN / ganti pengguna — data referensi pengguna itu harus diunduh) → segera
 *   (debounce 500 ms) dengan pull.
 * - **Kembali online** → segera (push + pull).
 * - **Kembali terlihat** → segera, dengan pull bila pull terakhir lebih lama dari `visiblePullMinGapMs` (60 dtk) —
 *   berpindah aplikasi berkali-kali (mis. kirim WA) tidak menarik data berulang.
 * - **Manual** ("Kirim sekarang") → `syncNow({ force: true })` di luar penjadwal (hooks), selalu push + pull.
 *
 * Setiap putaran (apa pun pemicunya) menjadwalkan ulang timer dari awal, sehingga pull setelah push juga
 * "mengatur ulang" jeda 5 menit. Murni (tanpa DOM/Dexie) — dependensi disuntikkan agar dapat diuji dengan waktu palsu.
 */

/** Jeda pull latar saat antrean kosong (D-14 butir 2). */
export const IDLE_PULL_INTERVAL_MS = 5 * 60_000;
/** Jeda putaran saat masih ada antrean (push/coba ulang). */
export const BUSY_SYNC_INTERVAL_MS = 60_000;
/** Jeda minimum pull saat aplikasi kembali terlihat. */
export const VISIBLE_PULL_MIN_GAP_MS = 60_000;
/** Debounce pemicu perubahan antrean. */
export const OUTBOX_DEBOUNCE_MS = 500;

export type SyncTrigger = "start" | "timer" | "outbox" | "request" | "online" | "visible";

/** Keputusan pull untuk satu putaran: `true` selalu; `"auto"` = bila push berhasil atau pull sudah jatuh tempo. */
export type PullMode = boolean | "auto";

export type SyncSchedulerDeps = {
  /** Jalankan satu putaran (`syncNow`). */
  run: (opts: { trigger: SyncTrigger; pull: PullMode }) => Promise<unknown>;
  /** Jumlah item antrean yang masih harus dikirim (semua pengguna di perangkat). */
  pendingCount: () => Promise<number>;
  /** Waktu pull berhasil terakhir (ms epoch) atau null. */
  lastPullAt: () => Promise<number | null>;
  /** Jeda idle (ms) — bawaan `IDLE_PULL_INTERVAL_MS`, dibatasi PAR-30 oleh pemanggil (`idleIntervalFor`). */
  idleIntervalMs?: () => Promise<number> | number;
  busyIntervalMs?: number;
  visiblePullMinGapMs?: number;
  isVisible?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type SyncScheduler = {
  /** Mulai: satu putaran segera, lalu terjadwal. */
  start: () => void;
  stop: () => void;
  /** Pemicu dari luar (kejadian peramban). */
  trigger: (reason: Exclude<SyncTrigger, "start" | "timer">) => void;
  /** Jeda timer yang sedang terpasang (uji/diagnostik). */
  currentDelay: () => number | null;
};

/** Jeda idle = min(5 menit, PAR-30 menit), minimal jeda sibuk. */
export function idleIntervalFor(syncMaxMinutes: number | null | undefined): number {
  const par30 = typeof syncMaxMinutes === "number" && syncMaxMinutes > 0 ? syncMaxMinutes * 60_000 : IDLE_PULL_INTERVAL_MS;
  return Math.max(BUSY_SYNC_INTERVAL_MS, Math.min(IDLE_PULL_INTERVAL_MS, par30));
}

export function createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());
  const isVisible = deps.isVisible ?? (() => true);
  const busyMs = deps.busyIntervalMs ?? BUSY_SYNC_INTERVAL_MS;
  const visibleGap = deps.visiblePullMinGapMs ?? VISIBLE_PULL_MIN_GAP_MS;
  const idleMs = async () => (deps.idleIntervalMs ? await deps.idleIntervalMs() : IDLE_PULL_INTERVAL_MS);

  let timer: unknown = null;
  let debounce: unknown = null;
  let delay: number | null = null;
  let stopped = true;
  let running = false;
  /** Pemicu yang datang saat putaran berjalan → satu putaran lagi segera setelahnya (tidak hilang). */
  let rerun: { trigger: SyncTrigger; pull: PullMode } | null = null;
  /** Pemicu antrean/permintaan yang sedang ditunda debounce (digabung). */
  let pendingDebounce: { trigger: SyncTrigger; pull: PullMode } | null = null;

  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    delay = null;
  };

  const schedule = async () => {
    const pending = await deps.pendingCount().catch(() => 0);
    const next = pending > 0 ? busyMs : await idleMs();
    if (stopped || running) return;
    clear();
    delay = next;
    timer = setTimer(() => void tick(), next);
  };

  const strongerPull = (a: PullMode, b: PullMode): PullMode => (a === true || b === true ? true : a === "auto" || b === "auto" ? "auto" : false);

  const execute = async (trigger: SyncTrigger, pull: PullMode): Promise<void> => {
    if (stopped) return;
    if (running) {
      rerun = rerun ? { trigger: rerun.trigger, pull: strongerPull(rerun.pull, pull) } : { trigger, pull };
      return;
    }
    running = true;
    clear();
    try {
      await deps.run({ trigger, pull });
    } catch {
      // Galat sinkron sudah dicatat di status sinkron; penjadwal tetap jalan.
    } finally {
      running = false;
    }
    if (stopped) return;
    if (rerun) {
      const again = rerun;
      rerun = null;
      return execute(again.trigger, again.pull);
    }
    await schedule();
  };

  const tick = async () => {
    timer = null;
    if (stopped) return;
    const pending = await deps.pendingCount().catch(() => 0);
    if (pending === 0 && !isVisible()) {
      // Antrean kosong & aplikasi tidak terlihat: tidak ada yang perlu dikirim — lewati pull (hemat kuota).
      await schedule();
      return;
    }
    await execute("timer", "auto");
  };

  const pullDueOnVisible = async (): Promise<PullMode> => {
    const last = await deps.lastPullAt().catch(() => null);
    return last === null || now() - last >= visibleGap ? true : "auto";
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void execute("start", true);
    },
    stop() {
      stopped = true;
      rerun = null;
      clear();
      if (debounce !== null) clearTimer(debounce);
      debounce = null;
      pendingDebounce = null;
    },
    trigger(reason) {
      if (stopped) return;
      if (reason === "outbox" || reason === "request") {
        // Beberapa pemicu beruntun → satu putaran; permintaan eksplisit (login) selalu menarik data.
        const incoming: { trigger: SyncTrigger; pull: PullMode } = reason === "request" ? { trigger: "request", pull: true } : { trigger: "outbox", pull: "auto" };
        pendingDebounce = pendingDebounce
          ? { trigger: pendingDebounce.trigger === "request" ? "request" : incoming.trigger, pull: strongerPull(pendingDebounce.pull, incoming.pull) }
          : incoming;
        if (debounce !== null) clearTimer(debounce);
        debounce = setTimer(() => {
          debounce = null;
          const next = pendingDebounce ?? { trigger: reason, pull: "auto" as PullMode };
          pendingDebounce = null;
          void execute(next.trigger, next.pull);
        }, OUTBOX_DEBOUNCE_MS);
        return;
      }
      if (reason === "online") {
        void execute("online", true);
        return;
      }
      void pullDueOnVisible().then((pull) => (stopped ? undefined : execute("visible", pull)));
    },
    currentDelay: () => delay,
  };
}
