import { getActorContext } from "@/server/core/actor";
import { assertSameOrigin } from "@/server/core/csrf";
import { errorResponse } from "@/server/core/errors";
import { exportReport, type ExportFormat } from "@/server/core/export";

/**
 * Unduh laporan (US-M9-03, BR-39): `GET /api/export/<kunci>?format=xlsx|pdf|csv&purpose=…&<filter>=…` atau
 * `POST` (form/JSON: `format`, `purpose`, filter) — dianjurkan untuk ekspor ber-data pribadi agar tujuan diketik di
 * formulir EQUA. Ekspor menulis `export_logs` & log akses, jadi permintaan LINTAS SITUS ditolak (CSRF: cookie
 * SameSite=Lax tetap terkirim pada navigasi GET). Pelaku dari `getActorContext` (cookie web kantor / token perangkat);
 * tanpa sesi → 401.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESERVED = new Set(["format", "purpose"]);

async function handle(request: Request, ctx: RouteContext<"/api/export/[report]">, params: Iterable<[string, string]>) {
  try {
    assertSameOrigin(request);
    const actor = await getActorContext(request);
    if (!actor) {
      return Response.json({ ok: false, message: "Silakan masuk terlebih dahulu untuk mengunduh laporan." }, { status: 401 });
    }
    const { report } = await ctx.params;
    let format: ExportFormat = "xlsx";
    let purpose: string | null = null;
    const filters: Record<string, unknown> = {};
    for (const [k, v] of params) {
      if (k === "format") format = (v || "xlsx") as ExportFormat;
      else if (k === "purpose") purpose = v;
      else if (!RESERVED.has(k) && v !== "") filters[k] = v;
    }
    const result = await exportReport(actor, decodeURIComponent(report), format, filters, purpose);
    return new Response(new Uint8Array(result.body), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "Cache-Control": "no-store",
        "X-Export-Rows": String(result.rowCount),
        "X-Export-Sha256": result.sha256,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request, ctx: RouteContext<"/api/export/[report]">) {
  return handle(request, ctx, new URL(request.url).searchParams.entries());
}

export async function POST(request: Request, ctx: RouteContext<"/api/export/[report]">) {
  const type = request.headers.get("content-type") ?? "";
  let entries: [string, string][] = [];
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      entries = Object.entries(body ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)]);
    } else {
      const form = await request.formData();
      entries = [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]);
    }
  } catch {
    entries = [];
  }
  const url = new URL(request.url);
  return handle(request, ctx, [...url.searchParams.entries(), ...entries]);
}
