/**
 * P2 — kanal pesan pelanggan: WhatsApp Business API (US-P2-08, PTB-60), notifikasi dalam aplikasi + Web Push
 * (US-P2-03 KP-4), dan pengiriman OTP (US-P2-01 KP-1).
 *
 * - `WhatsAppProvider` "cloud_api" versi P2 mengirim TEMPLATE resmi Meta (pesan yang dimulai bisnis wajib template)
 *   dengan cadangan teks; antarmuka sama dengan `@/server/core/wa` sehingga alur Tahap 1 tidak berubah (NFR-20).
 * - Tanpa token Cloud API (mode tautan, K21) tidak ada pengiriman otomatis; notifikasi dalam aplikasi tetap tercatat.
 * - OTP: Cloud API → template `otp`; mode tautan hanya di dev/uji/E2E (kode ditampilkan di layar, "mode uji"); di
 *   produksi tanpa Cloud API pendaftaran ditolak dengan pesan tindakan (prasyarat 8.1 #3).
 */
import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { getDb, onAfterCommit, type Tx } from "@/server/core/db";
import { customerAccounts, customerNotifications, customerPushSubscriptions, customers, waMessageLogs } from "@/db/schema";
import { devSecretsAllowed, serverEnv } from "@/lib/env";
import type { WaMessageKind } from "@/lib/labels";

import { DomainError } from "@/server/core/errors";
import { sendWebPush, type PushPayload, type PushResult } from "@/server/core/notifications";
import { assertWaNumber, buildWaLink, linkProvider, type TemplateVars, type WaSendRequest, type WaSendResult, type WhatsAppProvider } from "@/server/core/wa";

// =====================================================================================================================
// WhatsApp Cloud API (template)
// =====================================================================================================================

/** Nama template resmi Meta per jenis pesan (didaftarkan di WhatsApp Manager; bahasa `id`). */
export const WA_TEMPLATE_NAMES: Partial<Record<WaMessageKind, string>> = {
  otp: "equa_kode_otp",
  order_confirmation: "equa_konfirmasi_pesanan",
  order_status: "equa_status_pengiriman",
  trip_receipt: "equa_struk_pengiriman",
  payment_receipt: "equa_pembayaran_diterima",
  refill_reminder: "equa_pengingat_isi_ulang",
  customer_notice: "equa_pemberitahuan",
};

/** Kategori harga Meta per jenis pesan (NFR-29 — tarif `p2.wa_pricing`). */
export const WA_CATEGORY_BY_KIND: Partial<Record<WaMessageKind, "utility" | "authentication" | "marketing">> = {
  otp: "authentication",
  refill_reminder: "marketing",
};

export type CloudTemplateConfig = { token: string; phoneNumberId: string; fetchImpl?: typeof fetch; apiVersion?: string };

/**
 * Penyedia WhatsApp Cloud API (Meta) yang mengirim template (`templateName` + `variables` berurutan sebagai parameter
 * body); tanpa `templateName` → pesan teks. Gagal → `fallbackLink` (tautan wa.me tetap dapat dipakai, NFR-20).
 */
export function cloudTemplateProvider(config: CloudTemplateConfig): WhatsAppProvider {
  const doFetch = config.fetchImpl ?? fetch;
  const version = config.apiVersion ?? "v21.0";
  return {
    kind: "cloud_api",
    async send(request: WaSendRequest): Promise<WaSendResult> {
      const to = assertWaNumber(request.to);
      const fallbackLink = buildWaLink(to, request.text);
      const body = request.templateName
        ? {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
              name: request.templateName,
              language: { code: "id" },
              components: [
                {
                  type: "body",
                  parameters: Object.values(request.variables ?? {}).map((v) => ({ type: "text", text: String(v ?? "") })),
                },
              ],
            },
          }
        : { messaging_product: "whatsapp", to, type: "text", text: { body: request.text } };
      try {
        const res = await doFetch(`https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
        if (!res.ok || !json.messages?.[0]?.id) return { mode: "cloud_api", status: "failed", error: json.error?.message ?? `HTTP ${res.status}`, fallbackLink };
        return { mode: "cloud_api", status: "sent", providerMessageId: json.messages[0].id };
      } catch (error) {
        return { mode: "cloud_api", status: "failed", error: error instanceof Error ? error.message : String(error), fallbackLink };
      }
    },
  };
}

let waProviderOverride: WhatsAppProvider | null = null;

/** Ganti penyedia WA (uji). `null` = dari env. */
export function setCustomerWaProviderForTests(provider: WhatsAppProvider | null): void {
  waProviderOverride = provider;
}

/** Penyedia aktif: Cloud API bila `WA_PROVIDER=cloud_api` + token; selain itu tautan (tanpa kirim otomatis). */
export function customerWaProvider(): WhatsAppProvider {
  if (waProviderOverride) return waProviderOverride;
  const env = serverEnv();
  if (env.WA_PROVIDER === "cloud_api" && env.WA_CLOUD_TOKEN && env.WA_CLOUD_PHONE_ID) {
    return cloudTemplateProvider({ token: env.WA_CLOUD_TOKEN, phoneNumberId: env.WA_CLOUD_PHONE_ID });
  }
  return linkProvider;
}

/** Benar bila pesan WA terkirim otomatis (Cloud API aktif). */
export function isAutoWaActive(): boolean {
  return customerWaProvider().kind === "cloud_api";
}

export type SendWaInput = {
  tenantId: string;
  kind: WaMessageKind;
  toPhone: string;
  text: string;
  variables?: TemplateVars;
  customerId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  now: Date;
  /** Teks yang disimpan di log (mis. OTP disamarkan). Bawaan = `text`. */
  logText?: string;
};

export type SendWaResult = { status: "sent" | "failed" | "skipped"; logId: string | null; providerMessageId?: string | null; error?: string | null };

/**
 * Kirim WA otomatis lewat Cloud API + catat `wa_message_logs` (status terkirim; sampai/dibaca dari webhook). Mode
 * tautan → `skipped` (tidak ada klaim terkirim, K21).
 */
export async function sendCustomerWa(tx: Tx, input: SendWaInput): Promise<SendWaResult> {
  const provider = customerWaProvider();
  if (provider.kind !== "cloud_api") return { status: "skipped", logId: null };
  const to = assertWaNumber(input.toPhone);
  const res = await provider.send({ to, text: input.text, kind: input.kind, templateName: WA_TEMPLATE_NAMES[input.kind], variables: input.variables });
  const sent = res.mode === "cloud_api" && res.status === "sent";
  const [log] = await tx
    .insert(waMessageLogs)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      customerId: input.customerId ?? null,
      toPhone: to,
      renderedText: input.logText ?? input.text,
      objectType: input.objectType ?? null,
      objectId: input.objectId ?? null,
      provider: "cloud_api",
      status: sent ? "sent" : "failed",
      providerMessageId: sent && res.mode === "cloud_api" && res.status === "sent" ? res.providerMessageId : null,
      sentAt: sent ? input.now : null,
      error: res.mode === "cloud_api" && res.status === "failed" ? res.error : null,
    })
    .returning({ id: waMessageLogs.id });
  return {
    status: sent ? "sent" : "failed",
    logId: log!.id,
    providerMessageId: res.mode === "cloud_api" && res.status === "sent" ? res.providerMessageId : null,
    error: res.mode === "cloud_api" && res.status === "failed" ? res.error : null,
  };
}

// =====================================================================================================================
// OTP
// =====================================================================================================================

export type OtpDelivery = { channel: "wa" | "dev"; devCode?: string };

/** Kirim kode OTP (US-P2-01 KP-1). Kode TIDAK pernah disimpan utuh di log. */
export async function deliverOtp(tx: Tx, input: { tenantId: string; phone: string; code: string; validMinutes: number; now: Date; objectId?: string }): Promise<OtpDelivery> {
  if (isAutoWaActive()) {
    const res = await sendCustomerWa(tx, {
      tenantId: input.tenantId,
      kind: "otp",
      toPhone: input.phone,
      text: `Kode verifikasi EQUA Anda: ${input.code}. Berlaku ${input.validMinutes} menit. Jangan berikan kode ini kepada siapa pun.`,
      logText: `Kode verifikasi EQUA ****** (berlaku ${input.validMinutes} menit).`,
      variables: { kode: input.code },
      objectType: "otp_code",
      objectId: input.objectId ?? null,
      now: input.now,
    });
    if (res.status === "sent") return { channel: "wa" };
    throw new DomainError("OTP_SEND_FAILED", "Kode verifikasi gagal dikirim lewat WhatsApp. Coba lagi beberapa saat, atau hubungi kantor EQUA.");
  }
  if (devSecretsAllowed(serverEnv())) return { channel: "dev", devCode: input.code };
  throw new DomainError(
    "OTP_CHANNEL_UNAVAILABLE",
    "Pendaftaran lewat aplikasi belum tersedia karena WhatsApp Business API belum aktif. Silakan pesan lewat telepon/WhatsApp kantor.",
  );
}

// =====================================================================================================================
// Notifikasi pelanggan (dalam aplikasi + push + WA)
// =====================================================================================================================

type PushSender = (sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload) => Promise<PushResult>;
let pushSenderOverride: PushSender | null = null;

/** Ganti pengirim push pelanggan (uji). */
export function setCustomerPushSenderForTests(sender: PushSender | null): void {
  pushSenderOverride = sender;
}

export type NotifyCustomerInput = {
  tenantId: string;
  customerId: string;
  /** Hanya akun ini (bawaan: semua akun aktif pelanggan). */
  accountId?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  /** Kunci unik kejadian (satu notifikasi per kejadian per akun). */
  dedupeKey: string;
  now: Date;
  /** Pesan WA otomatis (Cloud API) — terkirim sekali per kejadian. */
  wa?: { kind: WaMessageKind; text: string; variables?: TemplateVars } | null;
  /** US-P2-08 KP-2: pelanggan tanpa aplikasi tetap menerima WA yang sama (ke nomor WA pelanggan M1). */
  waEvenWithoutApp?: boolean;
};

export type NotifyCustomerResult = { inApp: number; wa: SendWaResult | null };

async function activeAccountsOf(tx: Tx, customerId: string, accountId?: string | null) {
  const rows = await tx
    .select({ id: customerAccounts.id, phone: customerAccounts.phone })
    .from(customerAccounts)
    .where(and(eq(customerAccounts.customerId, customerId), eq(customerAccounts.status, "linked"), isNull(customerAccounts.deactivatedAt)));
  return accountId ? rows.filter((r) => r.id === accountId) : rows;
}

/** Catat notifikasi pelanggan (idempoten per `dedupeKey`), jadwalkan push setelah commit, kirim WA bila aktif. */
export async function notifyCustomer(tx: Tx, input: NotifyCustomerInput): Promise<NotifyCustomerResult> {
  const accounts = await activeAccountsOf(tx, input.customerId, input.accountId);
  const inserted: { id: string; accountId: string }[] = [];
  for (const acc of accounts) {
    const [row] = await tx
      .insert(customerNotifications)
      .values({
        tenantId: input.tenantId,
        customerAccountId: acc.id,
        customerId: input.customerId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        objectType: input.objectType ?? null,
        objectId: input.objectId ?? null,
        dedupeKey: `${input.dedupeKey}:${acc.id}`,
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: customerNotifications.id });
    if (row) inserted.push({ id: row.id, accountId: acc.id });
  }
  if (inserted.length) schedulePush(tx, inserted, { title: input.title, body: input.body ?? null, url: input.link ?? "/app" });

  let wa: SendWaResult | null = null;
  if (input.wa && isAutoWaActive() && (accounts.length > 0 || input.waEvenWithoutApp)) {
    // Satu WA per kejadian (baris penanda tanpa akun), ke nomor akun aplikasi bila ada, bila tidak ke nomor pelanggan M1.
    const [marker] = await tx
      .insert(customerNotifications)
      .values({
        tenantId: input.tenantId,
        customerAccountId: null,
        customerId: input.customerId,
        kind: `${input.kind}:wa`,
        title: input.title,
        body: input.wa.text,
        objectType: input.objectType ?? null,
        objectId: input.objectId ?? null,
        dedupeKey: `${input.dedupeKey}:wa`,
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: customerNotifications.id });
    if (marker) {
      const phone = accounts[0]?.phone ?? (await tx.select({ phone: customers.waPhone }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0]?.phone;
      if (phone && !phone.startsWith("anon-")) {
        wa = await sendCustomerWa(tx, {
          tenantId: input.tenantId,
          kind: input.wa.kind,
          toPhone: phone,
          text: input.wa.text,
          variables: input.wa.variables,
          customerId: input.customerId,
          objectType: input.objectType ?? null,
          objectId: input.objectId ?? null,
          now: input.now,
        });
        if (wa.logId) await tx.update(customerNotifications).set({ waMessageLogId: wa.logId }).where(eq(customerNotifications.id, marker.id));
      }
    }
  }
  return { inApp: inserted.length, wa };
}

function schedulePush(tx: Tx, rows: { id: string; accountId: string }[], payload: PushPayload): void {
  onAfterCommit(tx, async () => {
    const db = getDb();
    for (const row of rows) {
      const subs = await db
        .select()
        .from(customerPushSubscriptions)
        .where(and(eq(customerPushSubscriptions.customerAccountId, row.accountId), isNull(customerPushSubscriptions.revokedAt)));
      let sent = false;
      for (const sub of subs) {
        const res = await (pushSenderOverride ?? sendWebPush)({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
        if (res.ok) sent = true;
        if (res.gone) await db.update(customerPushSubscriptions).set({ revokedAt: new Date() }).where(eq(customerPushSubscriptions.id, sub.id));
      }
      if (sent) await db.update(customerNotifications).set({ pushSentAt: new Date() }).where(eq(customerNotifications.id, row.id));
    }
  });
}
