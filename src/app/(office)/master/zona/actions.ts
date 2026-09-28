"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import type { CustomerSegment } from "@/lib/labels";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, int, num, str } from "../_lib/form";

const base = "/master/zona";

/** Tabel zona baru (batas jarak) berlaku per tanggal (US-M1-05 KP-1). */
export async function proposeZoneTableAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  let status: string | undefined;
  const res = await attempt(async () => {
    const zones: m1.ProposeZoneTableInput["zones"] = [];
    const count = Number(str(fd, "zoneCount") ?? "0");
    for (let i = 0; i < count; i++) {
      const max = num(fd, `zone_${i}_max`);
      zones.push({ zoneId: str(fd, `zone_${i}_id`) ?? undefined, minKm: num(fd, `zone_${i}_min`) ?? Number.NaN, maxKm: max });
    }
    const newCode = str(fd, "new_code");
    if (newCode) {
      zones.push({ code: newCode, name: str(fd, "new_name") ?? newCode, minKm: num(fd, "new_min") ?? Number.NaN, maxKm: num(fd, "new_max") });
    }
    const r = await m1.proposeZoneTable(ctx, { effectiveFrom: str(fd, "effectiveFrom") ?? "", reason: str(fd, "reason") ?? "", zones });
    status = r.status;
  });
  revalidatePath(base);
  return res.ok ? { ...res, message: status === "active" ? "Tabel zona baru ditetapkan (keputusan langsung pemilik)." : "Usulan tabel zona dikirim ke pemilik." } : res;
}

/** Tarif per rit per zona (opsional per segmen) berlaku per tanggal. */
export async function proposeZoneTariffAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  let status: string | undefined;
  const res = await attempt(async () => {
    const r = await m1.proposeZoneTariff(ctx, {
      zoneId: str(fd, "zoneId") ?? "",
      segment: (str(fd, "segment") ?? null) as CustomerSegment | null,
      pricePerTrip: int(fd, "pricePerTrip") ?? Number.NaN,
      effectiveFrom: str(fd, "effectiveFrom") ?? "",
      reason: str(fd, "reason") ?? "",
    });
    status = r.status;
  });
  revalidatePath(base);
  return res.ok ? { ...res, message: status === "active" ? "Tarif zona baru ditetapkan." : "Usulan tarif zona dikirim ke pemilik." } : res;
}
