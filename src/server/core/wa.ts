/**
 * WhatsApp (K21, NFR-20, PTB-29, PTB-60). Tahap 1 = tautan `wa.me` semi-otomatis: sistem mencatat "dibuka" (tanpa
 * klaim terkirim/terbaca). Tahap 2 = adaptor WhatsApp Cloud API di balik antarmuka `WhatsAppProvider` yang sama —
 * alur Dispatcher/Admin Keuangan tidak berubah; bila API mati, tautan tetap berfungsi.
 *
 * - `normalizeWaNumber("0812-3456-7890")` → `"6281234567890"` (terima 08…, +62…, 62…, 8…).
 * - `renderTemplate("Halo {{nama}}", { nama: "Bu Ani" })`.
 * - `buildWaLink(phone, text)` → `https://wa.me/62812…?text=…`.
 * - `recordWaOpened(tx, ctx, {...})` → baris `wa_message_logs` (status `link_opened`).
 */
import "server-only";

import { waMessageLogs } from "@/db/schema";
import { serverEnv } from "@/lib/env";
import type { WaMessageKind } from "@/lib/labels";

import type { ActorContext } from "./context";
import type { Tx } from "./db";
import { DomainError, ValidationError } from "./errors";

/**
 * Normalisasi nomor WA Indonesia ke format internasional tanpa `+` (`628…`). Mengembalikan `null` bila bukan nomor
 * seluler Indonesia yang valid (awalan 8, 9–12 digit setelah 0/62).
 */
export function normalizeWaNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = String(input).trim();
  if (!/^[+\d\s().-]+$/.test(digits)) return null;
  digits = digits.replace(/[\s().-]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.startsWith("62")) national = digits.slice(2);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else if (digits.startsWith("8")) national = digits;
  else return null;
  if (national.startsWith("0")) national = national.slice(1);
  if (!/^8\d{8,11}$/.test(national)) return null;
  return `62${national}`;
}

/** Benar bila nomor WA Indonesia valid. */
export function isValidWaNumber(input: string | null | undefined): boolean {
  return normalizeWaNumber(input) !== null;
}

/** Normalisasi atau lempar ValidationError berbahasa Indonesia. */
export function assertWaNumber(input: string | null | undefined, field = "phone"): string {
  const normalized = normalizeWaNumber(input);
  if (!normalized) throw ValidationError.field(field, "Nomor WA tidak valid. Contoh yang benar: 0812-3456-7890.");
  return normalized;
}

/** Tampilan lokal `0812-3456-7890` dari `6281234567890`. */
export function formatWaNumber(normalized: string): string {
  const n = normalizeWaNumber(normalized);
  if (!n) return normalized;
  const local = `0${n.slice(2)}`;
  return local.replace(/^(\d{4})(\d{4})(\d+)$/, "$1-$2-$3");
}

export type TemplateVars = Record<string, string | number | null | undefined>;

/**
 * Isi penanda `{{nama_variabel}}` pada template (NFR-20). Variabel yang tidak ada → string kosong (tidak merusak
 * pesan); `missing` melaporkan variabel yang tidak terisi.
 */
export function renderTemplate(template: string, vars: TemplateVars): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null || v === "") {
      missing.add(key);
      return "";
    }
    return String(v);
  });
  return { text, missing: Array.from(missing) };
}

/** Tautan `wa.me` dengan pesan terisi. */
export function buildWaLink(phone: string, text: string): string {
  const normalized = assertWaNumber(phone);
  return `https://wa.me/${normalized}?text=${encodeURIComponent(text)}`;
}

export type RecordWaOpenedInput = {
  kind: WaMessageKind;
  toPhone: string;
  renderedText: string;
  templateId?: string | null;
  customerId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
};

/** Catat bahwa tautan WA dibuka (US-M2-07 KP-2: "konfirmasi dibuka", tanpa klaim terkirim). */
export async function recordWaOpened(tx: Tx, ctx: ActorContext, input: RecordWaOpenedInput) {
  const now = ctx.now ?? new Date();
  const [row] = await tx
    .insert(waMessageLogs)
    .values({
      tenantId: ctx.tenantId,
      kind: input.kind,
      templateId: input.templateId ?? null,
      customerId: input.customerId ?? null,
      toPhone: assertWaNumber(input.toPhone, "toPhone"),
      renderedText: input.renderedText,
      objectType: input.objectType ?? null,
      objectId: input.objectId ?? null,
      provider: "link",
      status: "link_opened",
      openedAt: now,
      openedBy: ctx.userId,
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Antarmuka penyedia (PTB-60)
// ---------------------------------------------------------------------------------------------------------------------

export type WaSendRequest = { to: string; text: string; kind: WaMessageKind; templateName?: string; variables?: TemplateVars };

export type WaSendResult =
  | { mode: "link"; link: string }
  | { mode: "cloud_api"; providerMessageId: string; status: "sent" }
  | { mode: "cloud_api"; status: "failed"; error: string; fallbackLink: string };

export interface WhatsAppProvider {
  readonly kind: "link" | "cloud_api";
  send(request: WaSendRequest): Promise<WaSendResult>;
}

/** Tahap 1: hanya menghasilkan tautan; pengguna mengetuk untuk membuka WhatsApp. */
export const linkProvider: WhatsAppProvider = {
  kind: "link",
  async send(request) {
    return { mode: "link", link: buildWaLink(request.to, request.text) };
  },
};

/**
 * Tahap 2 (US-P2-08): WhatsApp Cloud API (Meta). Dengan `templateName` → pesan TEMPLATE resmi Meta (bahasa `id`,
 * `variables` berurutan sebagai parameter body); tanpa `templateName` → pesan teks. Bila gagal, kembalikan tautan
 * cadangan (NFR-20: alur tetap berjalan). Dipakai bersama semua modul lewat `getWhatsAppProvider()` (B-69).
 */
export function cloudApiProvider(config: { token: string; phoneNumberId: string; fetchImpl?: typeof fetch; apiVersion?: string }): WhatsAppProvider {
  const doFetch = config.fetchImpl ?? fetch;
  const version = config.apiVersion ?? "v21.0";
  return {
    kind: "cloud_api",
    async send(request) {
      const to = assertWaNumber(request.to);
      const fallbackLink = buildWaLink(to, request.text);
      const payload = request.templateName
        ? {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: request.templateName,
              language: { code: "id" },
              components: [{ type: "body", parameters: Object.values(request.variables ?? {}).map((v) => ({ type: "text", text: String(v ?? "") })) }],
            },
          }
        : { messaging_product: "whatsapp", to, type: "text", text: { body: request.text } };
      try {
        const res = await doFetch(`https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
        if (!res.ok || !body.messages?.[0]?.id) {
          return { mode: "cloud_api", status: "failed", error: body.error?.message ?? `HTTP ${res.status}`, fallbackLink };
        }
        return { mode: "cloud_api", status: "sent", providerMessageId: body.messages[0].id };
      } catch (error) {
        return { mode: "cloud_api", status: "failed", error: error instanceof Error ? error.message : String(error), fallbackLink };
      }
    },
  };
}

/** Penyedia aktif dari env `WA_PROVIDER`. */
export function getWhatsAppProvider(): WhatsAppProvider {
  const env = serverEnv();
  if (env.WA_PROVIDER === "cloud_api") {
    if (!env.WA_CLOUD_TOKEN || !env.WA_CLOUD_PHONE_ID) {
      throw new DomainError("WA_NOT_CONFIGURED", "WhatsApp Cloud API belum dikonfigurasi. Gunakan tautan WA sementara.");
    }
    return cloudApiProvider({ token: env.WA_CLOUD_TOKEN, phoneNumberId: env.WA_CLOUD_PHONE_ID });
  }
  return linkProvider;
}

/** Rahasia webhook WhatsApp Cloud API dari env bersama tervalidasi (B-69): verifikasi langganan & tanda tangan Meta. */
export function waWebhookSecrets(): { verifyToken: string | null; appSecret: string | null } {
  const env = serverEnv();
  return { verifyToken: env.WA_WEBHOOK_VERIFY_TOKEN ?? null, appSecret: env.WA_APP_SECRET ?? null };
}
