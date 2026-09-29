/**
 * M12 — penerima posisi GPS (US-M12-01; NFR-21). Dipanggil rute `/api/gps/ingest/[vendor]` (token `GPS_INGEST_TOKEN`)
 * setelah adaptor vendor memetakan protokolnya ke format internal (`GpsFix`).
 *
 * - Perangkat → truk lewat master armada (`trucks.gps_device_id`, US-M1-03); cadangan penetapan unit perangkat (M10).
 *   Posisi disimpan per TRUK, sehingga pergantian ke perangkat cadangan tidak memutus riwayat truk (KP-2).
 * - Disimpan mentah (+ data vendor asli di `raw`), waktu server, penanda kualitas: akurasi, valid/tidak (akurasi >
 *   `m12.fleet_rules.max_accuracy_m`, fix tidak valid menurut vendor, koordinat 0,0) — posisi tidak valid tetap
 *   disimpan tetapi tidak dipakai deteksi (KP-5); jam perangkat menyimpang > PAR-42 ditandai (KP-5).
 * - Idempoten: unik (truk, sumber, waktu perangkat) → kirim ulang vendor tidak menggandakan posisi (KP-1).
 * - Kesehatan perangkat diperbarui (terakhir terlihat, daya, versi, baterai); daya terputus → Dicabut; posisi pertama
 *   setelah Mati/Dicabut → aktif kembali (US-M12-08).
 */
import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { devices, gpsPositions, trucks } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { withTx, type Db, type Tx } from "@/server/core/db";

import type { AdapterError, GpsFix } from "../domain/adapters";
import { m12Rules, type DeviceRow, type M12Rules } from "./common";
import { markDeviceOutage, restoreDevice, stopPhoneTracking } from "./devices";
import { createFleetEvent } from "./fleet-events";

export type IngestItemResult = { index: number; status: "accepted" | "duplicate" | "rejected"; message?: string };

export type IngestResult = {
  vendor: string;
  received: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  results: IngestItemResult[];
};

type Resolved = { device: DeviceRow; truck: { id: string; code: string; tenantId: string; status: string } } | { error: string };

/** Cari perangkat GPS dari pengenal vendor (IMEI atau kode perangkat) lalu truknya. */
export async function resolveGpsDevice(tx: Tx, ref: string): Promise<Resolved> {
  const code = ref.trim();
  const [device] = await tx
    .select()
    .from(devices)
    .where(and(eq(devices.kind, "gps"), sql`(${devices.imei} = ${code} or lower(${devices.deviceCode}) = lower(${code}))`))
    .limit(1);
  if (!device) return { error: `Perangkat GPS "${code}" belum terdaftar. Daftarkan di Akses > Perangkat lalu pasang di truk (Data master > Armada).` };
  if (["blocked", "wipe_pending", "wiped"].includes(device.status)) return { error: `Perangkat GPS ${device.deviceCode} diblokir; posisi tidak diterima.` };
  const byMaster = await tx
    .select({ id: trucks.id, code: trucks.code, tenantId: trucks.tenantId, status: trucks.status })
    .from(trucks)
    .where(eq(trucks.gpsDeviceId, device.id))
    .limit(1);
  let truck = byMaster[0];
  if (!truck && device.truckId) {
    const byAssignment = await tx
      .select({ id: trucks.id, code: trucks.code, tenantId: trucks.tenantId, status: trucks.status })
      .from(trucks)
      .where(and(eq(trucks.id, device.truckId), isNull(trucks.gpsDeviceId)))
      .limit(1);
    truck = byAssignment[0];
  }
  if (!truck) return { error: `Perangkat GPS ${device.deviceCode} belum dipasang di truk mana pun (Data master > Armada).` };
  return { device, truck };
}

/** Posisi valid untuk deteksi (US-M12-01 KP-5). */
export function isValidFix(fix: Pick<GpsFix, "vendorValid" | "accuracyM" | "lat" | "lng">, rules: Pick<M12Rules, "fleet">): boolean {
  if (fix.vendorValid === false) return false;
  if (fix.lat === 0 && fix.lng === 0) return false;
  if (fix.accuracyM !== null && fix.accuracyM > rules.fleet.max_accuracy_m) return false;
  return true;
}

/**
 * Simpan posisi dari penghubung vendor. Satu transaksi; posisi ditolak per butir (perangkat tak dikenal/diblokir/belum
 * dipasang) tanpa menggagalkan butir lain.
 */
export async function ingestGpsFixes(
  fixes: readonly GpsFix[],
  opts: { vendor: string; receivedAt?: Date; db?: Db; parseErrors?: readonly AdapterError[] },
): Promise<IngestResult> {
  const receivedAt = opts.receivedAt ?? new Date();
  const results: IngestItemResult[] = (opts.parseErrors ?? []).map((e) => ({ index: e.index, status: "rejected" as const, message: e.message }));
  return withTx(
    async (tx) => {
      const resolved = new Map<string, Resolved>();
      const rulesByTenant = new Map<string, M12Rules>();
      const byDevice = new Map<string, { device: DeviceRow; truck: { id: string; code: string; tenantId: string; status: string }; fixes: { fix: GpsFix; index: number; inserted: boolean }[] }>();

      for (const [index, fix] of fixes.entries()) {
        const key = fix.deviceRef.trim().toLowerCase();
        let r = resolved.get(key);
        if (!r) {
          r = await resolveGpsDevice(tx, fix.deviceRef);
          resolved.set(key, r);
        }
        if ("error" in r) {
          results.push({ index, status: "rejected", message: r.error });
          continue;
        }
        let rules = rulesByTenant.get(r.truck.tenantId);
        if (!rules) {
          rules = await m12Rules(tx, toBusinessDate(receivedAt), r.truck.tenantId);
          rulesByTenant.set(r.truck.tenantId, rules);
        }
        const group = byDevice.get(r.device.id) ?? { device: r.device, truck: r.truck, fixes: [] };
        byDevice.set(r.device.id, group);
        group.fixes.push({ fix, index, inserted: false });
      }

      for (const group of byDevice.values()) {
        const rules = rulesByTenant.get(group.truck.tenantId)!;
        // PAR-42: jam perangkat dinilai dari posisi TERBARU di kiriman ini (kiriman posisi tersimpan setelah sinyal
        // kembali diawali posisi lama yang sah).
        const newest = group.fixes.reduce((m, f) => Math.max(m, f.fix.deviceTime.getTime()), 0);
        const skewMs = Math.abs(receivedAt.getTime() - newest);
        const skewed = skewMs > rules.clockSkewMinutes * 60_000;
        for (const item of group.fixes) {
          const f = item.fix;
          const rows = await tx
            .insert(gpsPositions)
            .values({
              tenantId: group.truck.tenantId,
              truckId: group.truck.id,
              deviceId: group.device.id,
              source: "gps_device",
              deviceTime: f.deviceTime,
              serverTime: receivedAt,
              lat: f.lat,
              lng: f.lng,
              speedKmh: f.speedKmh,
              heading: f.heading,
              accuracyM: f.accuracyM,
              ignitionOn: f.ignitionOn,
              powerConnected: f.powerConnected,
              isValid: isValidFix(f, rules),
              clockSkewFlagged: skewed,
              vendor: opts.vendor,
              raw: f.raw,
            })
            .onConflictDoNothing()
            .returning({ id: gpsPositions.id });
          item.inserted = rows.length > 0;
          results.push({ index: item.index, status: item.inserted ? "accepted" : "duplicate" });
        }
        await updateDeviceHealth(tx, group, rules, { receivedAt, skewed, skewMs, vendor: opts.vendor });
      }

      results.sort((a, b) => a.index - b.index);
      return {
        vendor: opts.vendor,
        received: fixes.length + (opts.parseErrors?.length ?? 0),
        accepted: results.filter((r) => r.status === "accepted").length,
        duplicates: results.filter((r) => r.status === "duplicate").length,
        rejected: results.filter((r) => r.status === "rejected").length,
        results,
      };
    },
    { db: opts.db },
  );
}

async function updateDeviceHealth(
  tx: Tx,
  group: { device: DeviceRow; truck: { id: string; code: string; tenantId: string; status: string }; fixes: { fix: GpsFix; inserted: boolean }[] },
  rules: M12Rules,
  meta: { receivedAt: Date; skewed: boolean; skewMs: number; vendor: string },
): Promise<void> {
  const { device, truck } = group;
  const ordered = [...group.fixes].sort((a, b) => a.fix.deviceTime.getTime() - b.fix.deviceTime.getTime());
  const latest = ordered[ordered.length - 1]!;
  const lastAt = device.gpsLastPositionAt && device.gpsLastPositionAt.getTime() > latest.fix.deviceTime.getTime() ? device.gpsLastPositionAt : latest.fix.deviceTime;
  // Nilai kesehatan terbaru yang DILAPORKAN (tidak semua posisi membawa daya/versi/baterai).
  const lastReported = <K extends "powerConnected" | "firmwareVersion" | "batteryPct">(k: K): GpsFix[K] | null => {
    for (let i = ordered.length - 1; i >= 0; i--) if (ordered[i]!.fix[k] !== null && ordered[i]!.fix[k] !== undefined) return ordered[i]!.fix[k];
    return null;
  };
  const power = lastReported("powerConnected");
  const firmware = lastReported("firmwareVersion");
  const battery = lastReported("batteryPct");
  await tx
    .update(devices)
    .set({
      gpsLastPositionAt: lastAt,
      lastSeenAt: meta.receivedAt,
      ...(power !== null ? { gpsPowerConnected: power } : {}),
      ...(firmware ? { firmwareVersion: firmware } : {}),
      ...(battery !== null ? { batteryPct: battery } : {}),
      ...(!device.vendor ? { vendor: meta.vendor } : {}),
      ...(device.gpsState === null ? { gpsState: "active" as const, gpsStateSince: meta.receivedAt } : {}),
      updatedAt: meta.receivedAt,
    })
    .where(eq(devices.id, device.id));
  const fresh = { ...device, gpsLastPositionAt: lastAt, gpsPowerConnected: power ?? device.gpsPowerConnected };
  const truckRef = { id: truck.id, code: truck.code, tenantId: truck.tenantId };
  const newerThanState = latest.fix.deviceTime.getTime() >= (device.gpsStateSince?.getTime() ?? 0);
  if (power === false) {
    if (device.gpsState !== "unplugged") {
      // Perangkat Mati lalu mengirim lagi dengan daya terputus: tutup kejadian Mati dulu, lalu catat Dicabut.
      if (device.gpsState === "dead" && newerThanState) await restoreDevice(tx, { device: fresh, truck: truckRef, at: meta.receivedAt, now: meta.receivedAt });
      // US-M12-08 KP-1: sinyal daya terputus dari perangkat → Dicabut.
      await markDeviceOutage(tx, { device: { ...fresh, gpsState: "active" }, truck: truckRef, kind: "device_unplugged", since: latest.fix.deviceTime, now: meta.receivedAt });
    }
  } else if (newerThanState && (device.gpsState === "dead" || (device.gpsState === "unplugged" && power === true))) {
    // US-M12-08 KP-3: perangkat aktif kembali (Dicabut → hanya bila daya dilaporkan tersambung lagi).
    await restoreDevice(tx, { device: fresh, truck: truckRef, at: meta.receivedAt, now: meta.receivedAt });
  } else if (device.gpsState !== "unplugged" && device.gpsState !== "dead") {
    // Posisi perangkat kembali setelah gangguan vendor sistemik (perangkat tidak ditandai Mati): matikan GPS ponsel
    // cadangan otomatis (US-M12-01 KP-4). Penanda paksa admin sistem tetap.
    await stopPhoneTracking(tx, { truckId: truck.id, now: meta.receivedAt });
  }
  if (meta.skewed) {
    // PAR-42: satu kejadian informasional per perangkat per hari.
    const date = toBusinessDate(meta.receivedAt);
    await createFleetEvent(tx, {
      tenantId: truck.tenantId,
      kind: "clock_skew",
      dedupeKey: `skew:${device.id}:${date}`,
      truckId: truck.id,
      deviceId: device.id,
      businessDate: date,
      startedAt: meta.receivedAt,
      status: "done",
      details: { deviceCode: device.deviceCode, skewMinutes: Math.round(meta.skewMs / 60_000), thresholdMinutes: rules.clockSkewMinutes },
      rule: "US-M12-01 KP-5, PAR-42",
      now: meta.receivedAt,
    });
  }
}
