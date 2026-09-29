"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { P3ActionState } from "@/components/p3-partner/action-state";
import { loginWithPassword } from "@/server/core/auth";
import { getRequestMeta, setSessionCookie } from "@/server/core/auth/office";
import type { ActorContext } from "@/server/core/context";
import { withTx } from "@/server/core/db";
import { DomainError, toUserMessage, ValidationError } from "@/server/core/errors";
import { put } from "@/server/core/storage";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "./_session";

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Rupiah/angka bulat ("150.000" → 150000). */
function num(fd: FormData, name: string): number | null {
  const v = str(fd, name);
  if (v === null) return null;
  const n = Number(v.replace(/[^0-9-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function dec(fd: FormData, name: string): number | null {
  const v = str(fd, name);
  if (v === null) return null;
  const n = Number(v.replace(",", ".").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function attempt(fn: () => Promise<unknown>, message: string | ((r: unknown) => string), paths: string[]): Promise<P3ActionState> {
  try {
    const r = await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, message: typeof message === "function" ? message(r) : message };
  } catch (error) {
    if (!(error instanceof DomainError)) console.error("[equa] galat portal mitra:", error);
    return { error: toUserMessage(error) };
  }
}

/** Unggah foto/PDF formulir portal (maks. 4 MB, D-10 butir 3) → ID lampiran tenant mitra. */
async function upload(ctx: ActorContext, fd: FormData, name: string, kind: string): Promise<string | null> {
  const file = fd.get(name);
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > 4 * 1024 * 1024) throw ValidationError.field(name, "Berkas terlalu besar (maksimal 4 MB). Kompres foto atau pilih berkas lain.");
  const buf = Buffer.from(await file.arrayBuffer());
  const att = await withTx((tx) => put(tx, ctx, { blob: buf, contentType: file.type || "application/octet-stream", kind, originalName: file.name }));
  return att.id;
}

// ---------------------------------------------------------------------------------------------------- Masuk
export type PortalLoginResult = { error: string } | undefined;

/** Masuk portal pemilik mitra (US-P3-10 KP-1; D-07): antarmuka `portal`, bukan web kantor. */
export async function portalLoginAction(values: { username: string; password: string }): Promise<PortalLoginResult> {
  try {
    const res = await loginWithPassword({ username: values?.username ?? "", password: values?.password ?? "" }, await getRequestMeta(), { interface: "portal" });
    await setSessionCookie(res.token);
  } catch (error) {
    if (!(error instanceof DomainError)) console.error("[equa] galat masuk portal:", error);
    return { error: toUserMessage(error) };
  }
  redirect("/mitra");
}

// ---------------------------------------------------------------------------------------------------- RL-7
/** US-P3-11 KP-1: ajukan permintaan dukungan teknis (jenis, uraian, foto, outlet). */
export async function submitSupportAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requirePortalSession();
  return attempt(
    async () => {
      const photoAttachmentId = await upload(ctx, fd, "photo", "support_photo");
      return p3.submitSupportRequest(ctx, {
        outletId: str(fd, "outletId") ?? "",
        kind: (str(fd, "kind") ?? "") as p3.SubmitSupportInput["kind"],
        description: str(fd, "description") ?? "",
        photoAttachmentId,
      });
    },
    "Permintaan dukungan terkirim. EQUA menanggapi paling lambat 48 jam.",
    ["/mitra/dukungan"],
  );
}

// ---------------------------------------------------------------------------------------------------- Tahap 3
/** US-P3-04 KP-2: sengketa tagihan ≤ 7 hari (Tahap 3). */
export async function disputeInvoiceAction(invoiceId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requirePortalSession();
  return attempt(() => p3.disputePartnerInvoice(ctx, { invoiceId, note: str(fd, "note") ?? "" }), "Sengketa tagihan diajukan. Admin Keuangan EQUA akan menghubungi Anda.", ["/mitra/tagihan"]);
}

/** US-P3-03 KP-1/KP-2: pesan air dari portal (masuk M2 sebagai pesanan pelanggan mitra). */
export async function waterOrderAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requirePortalSession();
  try {
    const res = await p3.createPortalWaterOrder(ctx, {
      outletId: str(fd, "outletId") ?? "",
      tankCount: num(fd, "tankCount") ?? 1,
      requestedDate: str(fd, "requestedDate") ?? "",
      requestedTime: str(fd, "requestedTime"),
      paymentMethod: (str(fd, "paymentMethod") ?? "cash") as "cash" | "transfer" | "credit",
      notes: str(fd, "notes"),
      confirmAdditional: fd.get("confirmAdditional") === "on",
    });
    if (res.status !== "created") return { error: res.message };
    revalidatePath("/mitra/pesanan");
    return { ok: true, message: `Pesanan air ${res.orderNumber} terkirim ke Dispatcher EQUA.` };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** US-P3-03 KP-3: pesan spare part (katalog toko EQUA harga mitra; dikonfirmasi kasir toko). */
export async function sparePartOrderAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requirePortalSession();
  const items = fd
    .getAll("productId")
    .map((v, i) => ({ productId: String(v), quantity: Number(String(fd.getAll("quantity")[i] ?? "0").replace(/[^0-9]/g, "")) }))
    .filter((i) => i.productId && i.quantity > 0);
  return attempt(
    () =>
      p3.createPortalSparePartOrder(ctx, {
        outletId: str(fd, "outletId") ?? "",
        items,
        pickup: (str(fd, "pickup") ?? "store_pickup") as "store_pickup" | "with_truck",
        paymentMethod: (str(fd, "paymentMethod") ?? "cash") as "cash" | "transfer" | "credit",
        notes: str(fd, "notes"),
      }),
    "Pesanan spare part terkirim ke toko EQUA — menunggu konfirmasi kasir.",
    ["/mitra/pesanan"],
  );
}

export async function cancelSparePartAction(portalOrderId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requirePortalSession();
  return attempt(() => p3.cancelPortalSparePartOrder(ctx, { portalOrderId, reason: str(fd, "reason") ?? "" }), "Pesanan spare part dibatalkan.", ["/mitra/pesanan"]);
}

/** US-P3-02 KP-1: harga jual, kas awal tetap, ambang void — dalam batas EQUA, berlaku besok. */
export async function settingsAction(outletId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requirePortalSession();
  const prices = fd
    .getAll("priceProductId")
    .map((v, i) => ({ productId: String(v), raw: String(fd.getAll("price")[i] ?? "").trim() }))
    .filter((p) => p.raw !== "")
    .map((p) => ({ productId: p.productId, price: Number(p.raw.replace(/[^0-9]/g, "")) }));
  return attempt(
    () => p3.updatePartnerPosSettings(ctx, { outletId, prices, fixedOpeningCash: num(fd, "fixedOpeningCash"), voidThreshold: num(fd, "voidThreshold"), reason: str(fd, "reason") ?? "" }),
    (r) => `Pengaturan disimpan; berlaku mulai ${(r as { effectiveFrom: string }).effectiveFrom}.`,
    ["/mitra/pengaturan"],
  );
}

/** US-P3-01 KP-4: SOP diterima — tanda tangan digital pemilik mitra. */
export async function signSopAction(outletId: string, _prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  const { ctx } = await requirePortalSession();
  return attempt(() => p3.signSop(ctx, { outletId, signerName: str(fd, "signerName") ?? "", agree: (fd.get("agree") === "on") as true }), "SOP ditandatangani secara digital.", ["/mitra/mutu"]);
}

/** US-P3-01 KP-1: pendaftaran calon mitra publik (tanpa akun; hanya saat portal Tahap 3 aktif). */
export async function registerProspectAction(_prev: P3ActionState, fd: FormData): Promise<P3ActionState> {
  return attempt(
    () =>
      p3.registerProspectFromPortal({
        name: str(fd, "name") ?? "",
        businessEntity: str(fd, "businessEntity"),
        waPhone: str(fd, "waPhone") ?? "",
        proposedAddress: str(fd, "proposedAddress") ?? "",
        lat: dec(fd, "lat") ?? Number.NaN,
        lng: dec(fd, "lng") ?? Number.NaN,
        capitalAmount: num(fd, "capitalAmount"),
      }),
    "Pendaftaran terkirim. Pembina wilayah EQUA akan menghubungi Anda lewat WhatsApp untuk survei lokasi.",
    [],
  );
}
