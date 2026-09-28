"use server";

/**
 * Server Action jadwal kru (M2, US-M2-10, US-M2-11).
 */
import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m2-orders/action-state";
import type { EnumValue } from "@/lib/labels";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m2 from "@/server/modules/m2-orders";

import { attempt, int, str } from "../../pesanan/_lib/form";

function refresh() {
  revalidatePath("/jadwal/kru");
  revalidatePath("/jadwal");
}

/** Tetapkan pengemudi hari itu (US-M2-11). */
export async function setDriverAction(truckId: string, date: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const row = await m2.setDailyDriver(ctx, { truckId, date, employeeId: str(fd, "employeeId") ?? "", reason: str(fd, "reason") });
    return { message: row.source === "default_driver" ? "Sopir default ditetapkan." : "Pengemudi pengganti ditetapkan (berlaku sampai akhir hari kas)." };
  });
  refresh();
  return res;
}

/** Jadwal kru satu karyawan satu tanggal (US-M2-10 KP-1). */
export async function rosterAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const status = (str(fd, "status") ?? "on_duty") as EnumValue<"crew_roster_status">;
    await m2.setRosterEntry(ctx, {
      employeeId: str(fd, "employeeId") ?? "",
      date: str(fd, "date") ?? "",
      status,
      truckId: status === "on_duty" ? str(fd, "truckId") : null,
      role: status === "on_duty" ? ((str(fd, "role") ?? "driver") as EnumValue<"crew_role">) : null,
      notes: str(fd, "notes"),
    });
  }, "Jadwal kru disimpan.");
  refresh();
  return res;
}

/** Status truk per hari & kapasitas (US-M2-10 KP-2). */
export async function truckDayAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.setTruckDayStatus(ctx, {
      truckId: str(fd, "truckId") ?? "",
      date: str(fd, "date") ?? "",
      status: (str(fd, "status") ?? "operating") as EnumValue<"truck_day_status">,
      tripCapacity: int(fd, "tripCapacity"),
      reason: str(fd, "reason"),
    });
  }, "Status truk hari itu disimpan.");
  refresh();
  return res;
}
