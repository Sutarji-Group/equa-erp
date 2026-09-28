import { redirect } from "next/navigation";

import { requireOfficeSession } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";

/** Pintu masuk /sopir-kantor: arahkan ke layar M3 kantor pertama yang boleh dibuka pengguna. */
export default async function SopirKantorIndex() {
  const { ctx } = await requireOfficeSession();
  if (can(ctx, "m3.office_entry.create")) redirect("/sopir-kantor/dicatat-kantor");
  if (can(ctx, "m3.trip_incident.read")) redirect("/sopir-kantor/kendala");
  redirect("/sopir-kantor/laporan");
}
