import * as p2 from "@/server/modules/p2-customer";

/**
 * Webhook WhatsApp Cloud API (US-P2-08 KP-1/KP-3):
 * - GET: verifikasi langganan Meta (`hub.mode`, `hub.verify_token` = env `WA_WEBHOOK_VERIFY_TOKEN`, `hub.challenge`).
 * - POST: status pesan (terkirim/sampai/dibaca/gagal) + biaya pesan tertagih; tanda tangan `X-Hub-Signature-256`
 *   (env `WA_APP_SECRET`).
 */
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = p2.verifyWaWebhookChallenge({ mode: url.searchParams.get("hub.mode"), token: url.searchParams.get("hub.verify_token"), challenge: url.searchParams.get("hub.challenge") });
  if (!challenge) return new Response("Token verifikasi tidak cocok.", { status: 403 });
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!p2.verifyWaSignature(raw, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ ok: false, message: "Tanda tangan tidak sah." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, message: "Badan permintaan tidak valid." }, { status: 400 });
  }
  try {
    const out = await p2.handleWaStatusWebhook(body);
    return Response.json({ ok: true, ...out });
  } catch (error) {
    console.error("[equa] webhook WhatsApp gagal:", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
