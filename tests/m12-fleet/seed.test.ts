import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { gpsPositions } from "@/db/schema";
import { deviceId, truckId } from "@/db/seed";
import { seedDemoM12Fleet } from "@/db/seed/demo-m12-fleet";
import { getFleetSnapshot, getGpsDeviceHealth, listFleetEvents, runTravelDetection } from "@/server/modules/m12-fleet";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { wib } from "./helpers";

const NOW = wib("2026-09-24", "12:00");

describe("M12 — seed demo armada", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M12-02 KP-1 seed demo idempoten: jejak kemarin & hari ini untuk ketujuh truk, kejadian demo, perangkat dicabut dengan GPS ponsel cadangan", async () => {
    expect(await seedDemoM12Fleet(t.db, NOW)).toEqual({ positions: 0, events: 0 }); // dilewati saat uji tanpa `force`
    const first = await seedDemoM12Fleet(t.db, NOW, { force: true });
    expect(first.positions).toBeGreaterThan(500);
    expect(first.events).toBe(3); // tanpa rit Gagal demo M2/M3 → tanpa "berhenti tidak dikenal"
    expect(await seedDemoM12Fleet(t.db, NOW, { force: true })).toEqual({ positions: 0, events: 0 });
    for (const code of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
      const rows = await t.db.select({ id: gpsPositions.id }).from(gpsPositions).where(eq(gpsPositions.truckId, truckId(code)));
      expect(rows.length, code).toBeGreaterThan(50);
    }

    const snap = await getFleetSnapshot(seededContext("dispatcher1", { now: NOW }), {});
    const seeded = snap.trucks.filter((x) => /^T[1-7]$/.test(x.code));
    expect(seeded).toHaveLength(7);
    expect(seeded.filter((x) => x.position).length).toBe(7);
    expect(seeded.find((x) => x.code === "T7")).toMatchObject({ gpsState: "unplugged", phoneTracking: true, stale: true });

    const review = await listFleetEvents(seededContext("pemilik", { now: NOW }), { view: "review" });
    expect(review.find((e) => e.truckCode === "T4")).toMatchObject({ kind: "off_schedule_trip", status: "explained", explanation: expect.stringContaining("tambal ban") });
    const health = await getGpsDeviceHealth(seededContext("admin1", { now: NOW }), deviceId("GPS-T6"));
    expect(health).toMatchObject({ outages30d: 1, gpsState: "active", firmwareVersion: "FW-2.4.1" });

    // Jejak demo konsisten dengan aturan deteksi: gerak hari ini (isi di sumber, kembali ke pool) tidak ditandai.
    const res = await runTravelDetection(NOW, t.db);
    expect(res.filter((r) => /^T[1-7]$/.test(r.truckCode)).reduce((s, r) => s + r.created, 0)).toBe(0);
  });
});
