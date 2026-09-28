import { redirect } from "next/navigation";

import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";

/** Pintu masuk /armada: arahkan ke layar armada pertama yang boleh dibuka pengguna. */
export default async function ArmadaIndex() {
  const { ctx } = await requirePermission(["m12.position.read", "m12.trip_history.read", "m12.fleet_event.read", "m12.fuel_estimate.read"]);
  if (can(ctx, "m12.position.read")) redirect("/armada/peta");
  if (can(ctx, "m12.fleet_event.read")) redirect("/armada/kejadian");
  if (can(ctx, "m12.trip_history.read")) redirect("/armada/riwayat");
  redirect("/armada/bbm");
}
