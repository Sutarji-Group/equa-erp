import * as p2 from "@/server/modules/p2-customer";

/**
 * Webhook gerbang pembayaran (PTB-50; Midtrans HTTP notification / gerbang tiruan dev): tanda tangan diverifikasi
 * adaptor; Berhasil → pelunasan M5 + `digital_payment.succeeded` (US-P2-04 KP-3). Idempoten per pemberitahuan.
 * Balasan 200 untuk pemberitahuan yang dikenali (termasuk duplikat) agar gerbang berhenti mengulang; 401 bila tanda
 * tangan tidak sah.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Badan permintaan tidak valid." }, { status: 400 });
  }
  try {
    const out = await p2.handleGatewayNotification(body);
    if (out.result === "invalid") return Response.json({ ok: false, message: "Tanda tangan tidak sah." }, { status: 401 });
    return Response.json({ ok: true, result: out.result });
  } catch (error) {
    console.error("[equa] webhook pembayaran gagal:", error);
    return Response.json({ ok: false, message: "Gagal memproses pemberitahuan; gerbang akan mengulang." }, { status: 500 });
  }
}
