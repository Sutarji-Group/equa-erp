/**
 * Uji integrasi ronde 1: M1 (master karyawan) → M10 (akun pengguna) lewat event `employee.exited` (BR-37).
 * Masing-masing modul menguji sisinya sendiri; berkas ini memastikan keduanya tersambung setelah digabung.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { users } from "@/db/schema";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import * as m1 from "@/server/modules/m1-master";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { createTestUser } from "../helpers/factories";
import { days, sysadmin, T0, TODAY } from "../m1-master/helpers";

describe("Integrasi M1 → M10: tanggal keluar karyawan mencabut akses (BR-37)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function userRow(userId: string) {
    const [row] = await t.db.select().from(users).where(eq(users.id, userId));
    return row!;
  }

  it("US-M10-01 KP-5 / US-M1-04 KP-3 tanggal keluar hari ini di master M1 → akun M10 langsung nonaktif", async () => {
    const drv = await createTestUser(t.db, { role: "driver" });
    expect((await userRow(drv.userId)).status).toBe("active");

    await m1.updateEmployee(sysadmin(), drv.employeeId, { exitDate: TODAY });

    const row = await userRow(drv.userId);
    expect(row.status).toBe("inactive");
    expect(row.deactivationReason).toContain("BR-37");
  });

  it("US-M10-01 KP-5 / US-M1-04 KP-3 tanggal keluar di masa depan → akun tetap aktif sampai job harian M1 memancarkan ulang", async () => {
    const helper = await createTestUser(t.db, { role: "helper" });
    await m1.updateEmployee(sysadmin(), helper.employeeId, { exitDate: addDays(TODAY, 3) });
    expect((await userRow(helper.userId)).status).toBe("active");

    // Belum tercapai: tidak ada perubahan.
    await withTx((tx) => m1.processEmployeeExits(tx, T0));
    expect((await userRow(helper.userId)).status).toBe("active");

    // Tercapai: M1 menonaktifkan karyawan dan memancarkan `employee.exited` → M10 menonaktifkan akun.
    await withTx((tx) => m1.processEmployeeExits(tx, days(3)));
    expect((await userRow(helper.userId)).status).toBe("inactive");
  });
});
