/**
 * `pnpm tsx scripts/gps-simulate.ts` — simulator perangkat GPS truk (US-M12-01): mengirim posisi ke penghubung vendor
 * `/api/gps/ingest/<vendor>` seperti vendor sungguhan, sehingga peta real-time, riwayat, deteksi, dan peringatan
 * perangkat mati dapat dicoba tanpa perangkat fisik (R05: uji 1 unit sebelum pembelian penuh).
 *
 * Jejak dibangkitkan simulator murni (`src/server/modules/m12-fleet/domain/simulator.ts`): pool → sumber air (isi) →
 * pelanggan demo → sumber → … → pool. Waktu posisi = waktu sekarang (tidak pernah di masa depan): `--mundur` mengirim
 * jejak N menit terakhir sekaligus (seperti perangkat yang menyangga saat sinyal hilang), lalu mode langsung mengirim
 * satu posisi per truk tiap `60 / --percepat` detik.
 *
 * Opsi:
 *   --url <http://localhost:3000>        alamat aplikasi (env GPS_SIM_URL)
 *   --token <token>                      token penghubung (env GPS_INGEST_TOKEN; bawaan token dev)
 *   --vendor generic-json|osmand         protokol penghubung (bawaan generic-json)
 *   --truk T1,T2,…                       truk yang disimulasikan (bawaan T1–T7; perangkat GPS-T1…GPS-T7 dari seed)
 *   --mundur <menit>                     kirim jejak N menit terakhir lebih dulu (bawaan 60)
 *   --percepat <n>                       mode langsung: posisi berikutnya tiap 60/n detik (bawaan 1 = tiap menit)
 *   --durasi <menit>                     lama mode langsung (bawaan 30; 0 = hanya kirim jejak mundur)
 *   --skenario normal|luar-jadwal|cabut|mati
 *        luar-jadwal: T4 bergerak ke warung di luar lokasi sah tanpa rit (US-M12-05)
 *        cabut:       T7 mengirim sinyal daya terputus setelah 2 posisi langsung (US-M12-08 KP-1)
 *        mati:        T6 berhenti mengirim 20 menit pada mode langsung (PAR-25 → Mati, lalu aktif kembali)
 *
 * Contoh: `pnpm tsx scripts/gps-simulate.ts --mundur 90 --percepat 6 --durasi 20 --skenario luar-jadwal`
 */
import { CUSTOMER_SEEDS } from "@/db/seed/customers";
import { POOL_SEED, TRUCK_CODES, WATER_SOURCE_SEEDS } from "@/db/seed/org";
import type { LatLng } from "@/lib/geo";
import { offsetMeters, simulateRoute, truckDayWaypoints, type SimFix, type SimWaypoint } from "@/server/modules/m12-fleet/domain/simulator";

type Options = {
  url: string;
  token: string;
  vendor: "generic-json" | "osmand";
  trucks: string[];
  backfillMin: number;
  speedup: number;
  durationMin: number;
  scenario: "normal" | "luar-jadwal" | "cabut" | "mati";
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function options(): Options {
  const vendor = arg("vendor") ?? "generic-json";
  if (vendor !== "generic-json" && vendor !== "osmand") throw new Error(`Vendor "${vendor}" tidak dikenal (generic-json | osmand).`);
  const scenario = (arg("skenario") ?? "normal") as Options["scenario"];
  if (!["normal", "luar-jadwal", "cabut", "mati"].includes(scenario)) throw new Error(`Skenario "${scenario}" tidak dikenal.`);
  const trucks = (arg("truk") ?? TRUCK_CODES.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => (TRUCK_CODES as readonly string[]).includes(s));
  if (trucks.length === 0) throw new Error("Pilih minimal satu truk T1–T7.");
  return {
    url: (arg("url") ?? process.env.GPS_SIM_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    token: arg("token") ?? process.env.GPS_INGEST_TOKEN ?? "dev-gps-ingest-token",
    vendor,
    trucks,
    backfillMin: Math.max(0, Number(arg("mundur") ?? 60)),
    speedup: Math.max(1, Number(arg("percepat") ?? 1)),
    durationMin: Math.max(0, Number(arg("durasi") ?? 30)),
    scenario,
  };
}

const POOL: LatLng = { lat: POOL_SEED.lat, lng: POOL_SEED.lng };
const SOURCES: LatLng[] = WATER_SOURCE_SEEDS.map((s) => ({ lat: s.lat, lng: s.lng }));
const HOUSEHOLDS: LatLng[] = CUSTOMER_SEEDS.filter((c) => c.point).map((c) => c.point!);

/** Rute satu truk untuk sesi simulasi (deterministik per nomor truk). */
function routeFor(code: string, scenario: Options["scenario"]): SimWaypoint[] {
  const n = Number(code.slice(1));
  if (scenario === "luar-jadwal" && code === "T4") {
    const warung = offsetMeters(POOL, -2_400, -1_300);
    return [
      { ...POOL, dwellMin: 5 },
      { ...warung, dwellMin: 25, label: "warung (di luar lokasi sah)" },
      { ...POOL, dwellMin: 30 },
    ];
  }
  const customers = [0, 1, 2].map((k) => HOUSEHOLDS[(n * 3 + k * 5) % HOUSEHOLDS.length]!);
  return truckDayWaypoints({ pool: POOL, source: SOURCES[n % SOURCES.length]!, customers, start: new Date(), seed: n });
}

type Sender = (code: string, fixes: { t: Date; p: SimFix; power: boolean }[]) => Promise<void>;

function genericSender(o: Options): Sender {
  return async (code, fixes) => {
    const positions = fixes.map(({ t, p, power }) => ({
      deviceId: `GPS-${code}`,
      time: t.toISOString(),
      lat: Number(p.lat.toFixed(6)),
      lng: Number(p.lng.toFixed(6)),
      speedKmh: p.speedKmh,
      heading: p.heading,
      accuracyM: 8,
      ignition: p.speedKmh > 0,
      power,
      battery: 100,
      firmware: "SIM-1.0",
      valid: true,
    }));
    for (let i = 0; i < positions.length; i += 400) {
      const res = await fetch(`${o.url}/api/gps/ingest/generic-json`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ positions: positions.slice(i, i + 400) }),
      });
      const body = (await res.json().catch(() => ({}))) as { accepted?: number; duplicates?: number; rejected?: number; message?: string; results?: { message?: string }[] };
      const reason = body.message ?? body.results?.find((r) => r.message)?.message ?? "";
      console.log(`${code}: HTTP ${res.status} — diterima ${body.accepted ?? 0}, duplikat ${body.duplicates ?? 0}, ditolak ${body.rejected ?? 0}${reason ? ` (${reason})` : ""}`);
    }
  };
}

function osmandSender(o: Options): Sender {
  return async (code, fixes) => {
    let ok = 0;
    for (const { t, p, power } of fixes) {
      const q = new URLSearchParams({
        id: `GPS-${code}`,
        lat: p.lat.toFixed(6),
        lon: p.lng.toFixed(6),
        timestamp: String(Math.floor(t.getTime() / 1000)),
        speed: (p.speedKmh / 1.852).toFixed(1),
        bearing: String(p.heading),
        accuracy: "8",
        batt: "100",
        charge: String(power),
        token: o.token,
      });
      const res = await fetch(`${o.url}/api/gps/ingest/osmand?${q.toString()}`);
      if (res.ok) ok++;
      else console.log(`${code}: HTTP ${res.status} — ${((await res.json().catch(() => ({}))) as { message?: string }).message ?? ""}`);
    }
    console.log(`${code}: ${ok}/${fixes.length} posisi terkirim (OsmAnd)`);
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const o = options();
  const send = o.vendor === "osmand" ? osmandSender(o) : genericSender(o);
  const now = Date.now();
  const liveSteps = Math.round(o.durationMin * o.speedup);
  const plans = new Map<string, SimFix[]>();
  for (const code of o.trucks) {
    // Satu posisi per menit simulasi, cukup untuk jejak mundur + mode langsung.
    const fixes = simulateRoute({ start: new Date(now - o.backfillMin * 60_000), waypoints: routeFor(code, o.scenario), speedKmh: 32, intervalS: 60, seed: Number(code.slice(1)) });
    plans.set(code, fixes);
  }
  console.log(`Simulator GPS → ${o.url} (${o.vendor}); truk ${o.trucks.join(", ")}; skenario ${o.scenario}.`);

  // 1) Jejak mundur (waktu asli ≤ sekarang).
  for (const code of o.trucks) {
    const fixes = plans.get(code)!.filter((f) => f.t.getTime() <= now);
    if (fixes.length) await send(code, fixes.map((p) => ({ t: p.t, p, power: true })));
  }
  if (liveSteps === 0) return;

  // 2) Mode langsung: posisi berikutnya dengan waktu sekarang.
  const cursor = new Map(o.trucks.map((c) => [c, plans.get(c)!.filter((f) => f.t.getTime() <= now).length]));
  for (let step = 0; step < liveSteps; step++) {
    await sleep((60 / o.speedup) * 1000);
    const t = new Date();
    for (const code of o.trucks) {
      const fixes = plans.get(code)!;
      const i = Math.min(cursor.get(code)!, fixes.length - 1);
      cursor.set(code, i + 1);
      if (o.scenario === "mati" && code === "T6" && step >= 2 && step < 2 + 20 * o.speedup) continue;
      const power = !(o.scenario === "cabut" && code === "T7" && step >= 2);
      await send(code, [{ t, p: fixes[i]!, power }]);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message === "fetch failed" ? "Aplikasi tidak dapat dihubungi. Jalankan `pnpm dev` (atau isi --url) lalu ulangi." : message);
  process.exitCode = 1;
});
