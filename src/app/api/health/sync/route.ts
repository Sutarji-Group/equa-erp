import { sql } from "drizzle-orm";

import { getDb } from "@/server/core/db";

/**
 * Kesiapan API sinkron lapangan/POS untuk pemantau uptime EKSTERNAL (NFR-02, NFR-28): tanpa autentikasi, tanpa data —
 * hanya memeriksa basis data dapat dijangkau (dependensi utama `/api/sync/*`). Gagal → 503.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true, service: "sync", time: new Date().toISOString() });
  } catch {
    return Response.json({ ok: false, service: "sync", message: "Basis data tidak dapat dijangkau." }, { status: 503 });
  }
}
