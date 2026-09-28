/**
 * P2 — adaptor gerbang pembayaran generik (PTB-50, D-03): antarmuka `PaymentGateway`; implementasi pertama Midtrans
 * (Core API: QRIS dinamis & virtual account; sandbox bila `MIDTRANS_IS_PRODUCTION=false`) dan gerbang tiruan (`mock`)
 * untuk dev/uji/E2E. Pemberitahuan (webhook) diverifikasi tanda tangannya oleh adaptor.
 *
 * - Midtrans: `signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)`; status `settlement`/`capture`
 *   = Berhasil, `expire` = Kedaluwarsa, `deny`/`cancel`/`failure` = Gagal.
 * - Tiruan: tanda tangan HMAC dari `SESSION_SECRET` (hanya bila rahasia dev diizinkan — tidak pernah di produksi).
 */
import "server-only";

import { createHash, createHmac } from "node:crypto";

import { devSecretsAllowed, serverEnv } from "@/lib/env";

import { safeEqual } from "@/server/core/auth/crypto";

export type GatewayMethod = "qris_dynamic" | "virtual_account";

export type ChargeRequest = {
  gatewayOrderId: string;
  amount: number;
  method: GatewayMethod;
  vaBank: string;
  expiryMinutes: number;
  customer: { name: string; phone: string };
  now: Date;
};

export type ChargeResult = {
  transactionId: string | null;
  qrString: string | null;
  /** URL gambar QR (Midtrans `generate-qr-code`). */
  qrUrl: string | null;
  vaNumber: string | null;
  vaBank: string | null;
  expiresAt: Date;
  raw: Record<string, unknown>;
};

export type GatewayNotification = {
  gatewayOrderId: string;
  transactionId: string | null;
  status: "pending" | "succeeded" | "failed" | "expired";
  grossAmount: number;
  paymentType: string | null;
  raw: Record<string, unknown>;
};

export interface PaymentGateway {
  readonly key: "midtrans" | "mock";
  charge(request: ChargeRequest): Promise<ChargeResult>;
  /** Verifikasi tanda tangan + urai pemberitahuan. `null` = tanda tangan tidak sah. */
  parseNotification(body: Record<string, unknown>): GatewayNotification | null;
}

function toAmount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

function mapMidtransStatus(transactionStatus: string, fraudStatus?: string): GatewayNotification["status"] {
  if (transactionStatus === "settlement") return "succeeded";
  if (transactionStatus === "capture") return fraudStatus === "challenge" ? "pending" : "succeeded";
  if (transactionStatus === "expire") return "expired";
  if (["deny", "cancel", "failure"].includes(transactionStatus)) return "failed";
  return "pending";
}

export class GatewayError extends Error {}

/** Midtrans Core API (sandbox/produksi). */
export function midtransGateway(config: { serverKey: string; isProduction: boolean; fetchImpl?: typeof fetch }): PaymentGateway {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.isProduction ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
  const auth = `Basic ${Buffer.from(`${config.serverKey}:`).toString("base64")}`;
  return {
    key: "midtrans",
    async charge(req) {
      const common = {
        transaction_details: { order_id: req.gatewayOrderId, gross_amount: req.amount },
        customer_details: { first_name: req.customer.name.slice(0, 50), phone: req.customer.phone },
        custom_expiry: { expiry_duration: req.expiryMinutes, unit: "minute" },
      };
      const body = req.method === "qris_dynamic" ? { ...common, payment_type: "qris", qris: { acquirer: "gopay" } } : { ...common, payment_type: "bank_transfer", bank_transfer: { bank: req.vaBank } };
      const res = await doFetch(`${base}/v2/charge`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const code = String(json.status_code ?? res.status);
      if (!res.ok || !["200", "201"].includes(code)) {
        throw new GatewayError(String(json.status_message ?? `Gerbang pembayaran menolak (HTTP ${res.status}).`));
      }
      const actions = (json.actions as { name?: string; url?: string }[] | undefined) ?? [];
      const va = (json.va_numbers as { bank?: string; va_number?: string }[] | undefined)?.[0] ?? null;
      const permataVa = typeof json.permata_va_number === "string" ? json.permata_va_number : null;
      return {
        transactionId: typeof json.transaction_id === "string" ? json.transaction_id : null,
        qrString: typeof json.qr_string === "string" ? json.qr_string : null,
        qrUrl: actions.find((a) => a.name === "generate-qr-code")?.url ?? null,
        vaNumber: va?.va_number ?? permataVa,
        vaBank: va?.bank ?? (permataVa ? "permata" : null),
        expiresAt: new Date(req.now.getTime() + req.expiryMinutes * 60_000),
        raw: json,
      };
    },
    parseNotification(body) {
      const orderId = String(body.order_id ?? "");
      const statusCode = String(body.status_code ?? "");
      const gross = String(body.gross_amount ?? "");
      const signature = String(body.signature_key ?? "");
      if (!orderId || !signature) return null;
      const expected = createHash("sha512").update(`${orderId}${statusCode}${gross}${config.serverKey}`).digest("hex");
      if (!safeEqual(expected, signature)) return null;
      return {
        gatewayOrderId: orderId,
        transactionId: typeof body.transaction_id === "string" ? body.transaction_id : null,
        status: mapMidtransStatus(String(body.transaction_status ?? ""), typeof body.fraud_status === "string" ? body.fraud_status : undefined),
        grossAmount: toAmount(body.gross_amount),
        paymentType: typeof body.payment_type === "string" ? body.payment_type : null,
        raw: body,
      };
    },
  };
}

/** Kunci tanda tangan gerbang tiruan (turunan SESSION_SECRET). */
function mockKey(): string {
  return createHash("sha256").update(`p2-mock-gateway:${serverEnv().SESSION_SECRET}`).digest("hex");
}

/** Tanda tangan pemberitahuan gerbang tiruan (dipakai simulasi dev/uji/E2E). */
export function signMockNotification(body: { order_id: string; transaction_status: string; gross_amount: string | number }): string {
  return createHmac("sha256", mockKey()).update(`${body.order_id}|${body.transaction_status}|${body.gross_amount}`).digest("hex");
}

/** Gerbang tiruan (dev/uji/E2E): QRIS & VA palsu, pemberitahuan ditandatangani HMAC. */
export function mockGateway(): PaymentGateway {
  return {
    key: "mock",
    async charge(req) {
      const seq = req.gatewayOrderId.replace(/[^0-9A-Z]/gi, "").slice(-10).toUpperCase();
      return {
        transactionId: `MOCK-${seq}`,
        qrString: req.method === "qris_dynamic" ? `00020101021226MOCKQRIS${seq}5204581253033605404${req.amount}5802ID5904EQUA6007CIANJUR6304ABCD` : null,
        qrUrl: null,
        vaNumber: req.method === "virtual_account" ? `8808${String(Math.abs(hashInt(req.gatewayOrderId))).padStart(10, "0").slice(0, 10)}` : null,
        vaBank: req.method === "virtual_account" ? req.vaBank : null,
        expiresAt: new Date(req.now.getTime() + req.expiryMinutes * 60_000),
        raw: { mock: true },
      };
    },
    parseNotification(body) {
      const orderId = String(body.order_id ?? "");
      const status = String(body.transaction_status ?? "");
      const gross = String(body.gross_amount ?? "");
      const signature = String(body.signature ?? "");
      if (!orderId || !signature) return null;
      if (!safeEqual(signMockNotification({ order_id: orderId, transaction_status: status, gross_amount: gross }), signature)) return null;
      return {
        gatewayOrderId: orderId,
        transactionId: typeof body.transaction_id === "string" ? body.transaction_id : `MOCK-${orderId}`,
        status: mapMidtransStatus(status),
        grossAmount: toAmount(gross),
        paymentType: typeof body.payment_type === "string" ? body.payment_type : "mock",
        raw: body,
      };
    },
  };
}

function hashInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

let gatewayOverride: PaymentGateway | null | undefined;

/** Ganti gerbang (uji). `undefined` = dari env; `null` = tidak tersedia. */
export function setPaymentGatewayForTests(gateway: PaymentGateway | null | undefined): void {
  gatewayOverride = gateway;
}

/**
 * Gerbang aktif: `PAYMENT_GATEWAY=midtrans` → Midtrans; bila tidak dikonfigurasi → gerbang tiruan HANYA di
 * dev/uji/E2E; di produksi tanpa konfigurasi pembayaran digital tidak ditawarkan.
 */
export function activeGateway(): PaymentGateway | null {
  if (gatewayOverride !== undefined) return gatewayOverride;
  const env = serverEnv();
  if (env.PAYMENT_GATEWAY === "midtrans" && env.MIDTRANS_SERVER_KEY) return midtransGateway({ serverKey: env.MIDTRANS_SERVER_KEY, isProduction: env.MIDTRANS_IS_PRODUCTION });
  if (devSecretsAllowed(env)) return mockGateway();
  return null;
}

export function digitalPaymentAvailable(): boolean {
  return activeGateway() !== null;
}
