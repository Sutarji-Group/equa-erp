import { timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/lib/env";
import { errorResponse } from "@/server/core/errors";
import { recordServiceOutage } from "@/server/modules/m10-access";

/**
 * Pemantau uptime eksternal (`scripts/uptime-monitor.sh` di GitHub Actions) melaporkan gangguan yang sudah PULIH:
 * `{ service: "web" | "sync", startedAt, endedAt }` → gangguan tercatat dengan durasinya + insiden `service_down`
 * (NFR-02, NFR-28, US-M10-07 KP-2). Header `Authorization: Bearer $CRON_SECRET`; idempoten per layanan + mulai.
 */
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${serverEnv().CRON_SECRET}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ ok: false, message: "Tidak diizinkan." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const res = await recordServiceOutage({
      service: body?.service as "web",
      source: "external_monitor",
      startedAt: body?.startedAt as string,
      endedAt: body?.endedAt as string,
      note: typeof body?.note === "string" ? body.note : null,
    });
    return Response.json({ ok: true, created: res.created, durationMinutes: res.outage.durationMinutes, inMaintenanceWindow: res.outage.inMaintenanceWindow });
  } catch (error) {
    return errorResponse(error);
  }
}
