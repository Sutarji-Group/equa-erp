/** Pemeriksaan kesehatan ringan (tanpa DB) — dipakai Playwright webServer & pemantauan uptime. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, service: "equa-erp", time: new Date().toISOString() });
}
