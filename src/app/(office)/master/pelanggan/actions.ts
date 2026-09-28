"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionState } from "@/components/m1-master/action-state";
import type { CustomerSegment } from "@/lib/labels";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as approvals from "@/server/core/approvals";
import * as m1 from "@/server/modules/m1-master";

import { attempt, bool, coord, int, str } from "../_lib/form";

const base = "/master/pelanggan";

function revalidateCustomer(id?: string) {
  revalidatePath(base);
  if (id) revalidatePath(`${base}/${id}`);
}

/** Pelanggan baru (US-M1-01 KP-1/KP-2/KP-7): kandidat duplikat dikembalikan untuk dikonfirmasi. */
export async function createCustomerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  let createdId: string | null = null;
  const res = await attempt(async () => {
    const point = coord(fd, "addr_");
    const r = await m1.createCustomer(ctx, {
      code: str(fd, "code"),
      name: str(fd, "name") ?? "",
      segment: (str(fd, "segment") ?? "") as CustomerSegment,
      waPhone: str(fd, "waPhone") ?? "",
      contactName: str(fd, "contactName"),
      notes: str(fd, "notes"),
      fixedReceiveTime: str(fd, "fixedReceiveTime"),
      addresses: [
        {
          label: str(fd, "addr_label") ?? "Utama",
          addressText: str(fd, "addr_text") ?? "",
          lat: point.lat,
          lng: point.lng,
          notes: str(fd, "addr_notes"),
          manualZoneId: str(fd, "addr_zone"),
          manualZoneReason: str(fd, "addr_zone_reason"),
        },
      ],
      confirmDuplicate: bool(fd, "confirmDuplicate"),
      duplicateNote: str(fd, "duplicateNote"),
    });
    if (r.status === "duplicates") {
      return {
        error: "Ditemukan pelanggan yang mirip. Periksa daftar di bawah; bila memang berbeda, centang konfirmasi lalu simpan lagi.",
        duplicates: r.candidates.map((c) => ({ customerId: c.customerId, code: c.code, name: c.name, reasonText: c.reasonText, isActive: c.isActive })),
      };
    }
    createdId = r.customer.id;
  });
  if (createdId) {
    revalidatePath(base);
    redirect(`${base}/${createdId}?baru=1`);
  }
  return res;
}

export async function updateCustomerAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m1.updateCustomer(ctx, id, {
      name: str(fd, "name") ?? undefined,
      segment: (str(fd, "segment") ?? undefined) as CustomerSegment | undefined,
      waPhone: str(fd, "waPhone") ?? undefined,
      contactName: str(fd, "contactName"),
      notes: str(fd, "notes"),
      fixedReceiveTime: str(fd, "fixedReceiveTime"),
      confirmDuplicate: bool(fd, "confirmDuplicate"),
      correctionReason: str(fd, "correctionReason"),
    });
    if (r.status === "duplicates") {
      return {
        error: "Nomor WA ini sudah dipakai pelanggan lain. Centang konfirmasi bila memang benar.",
        duplicates: r.candidates.map((c) => ({ customerId: c.customerId, code: c.code, name: c.name, reasonText: c.reasonText, isActive: c.isActive })),
      };
    }
  }, "Data pelanggan disimpan.");
  revalidateCustomer(id);
  return res;
}

export async function addAddressAction(customerId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const point = coord(fd, "addr_");
  const res = await attempt(async () => {
    await m1.addAddress(ctx, customerId, {
      label: str(fd, "addr_label") ?? "",
      addressText: str(fd, "addr_text") ?? "",
      lat: point.lat,
      lng: point.lng,
      notes: str(fd, "addr_notes"),
      manualZoneId: str(fd, "addr_zone"),
      manualZoneReason: str(fd, "addr_zone_reason"),
    });
  }, "Alamat kirim ditambahkan.");
  revalidateCustomer(customerId);
  return res;
}

export async function setCoordinatesAction(customerId: string, addressId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const point = coord(fd, `c_${addressId}_`);
  const res = await attempt(async () => {
    if (point.lat === null || point.lng === null) throw new Error("Isi lintang dan bujur, atau pilih titik di peta.");
    await m1.setAddressCoordinates(ctx, addressId, { lat: point.lat, lng: point.lng });
  }, "Koordinat dikunci dan zona dipetakan otomatis.");
  revalidateCustomer(customerId);
  return res;
}

export async function setManualZoneAction(customerId: string, addressId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m1.setAddressManualZone(ctx, addressId, { zoneId: str(fd, "zoneId") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Zona manual ditetapkan.");
  revalidateCustomer(customerId);
  return res;
}

export async function clearManualZoneAction(customerId: string, addressId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.clearAddressManualZone(ctx, addressId, reason).then(() => undefined), "Zona kembali otomatis.");
  revalidateCustomer(customerId);
  return res;
}

export async function setReferenceSourceAction(customerId: string, addressId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m1.setAddressReferenceSource(ctx, addressId, { waterSourceId: str(fd, "waterSourceId"), reason: str(fd, "reason") ?? "" });
  }, "Sumber air acuan diubah; jarak & zona dihitung ulang.");
  revalidateCustomer(customerId);
  return res;
}

export async function deactivateAddressAction(customerId: string, addressId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.deactivateAddress(ctx, addressId, reason).then(() => undefined), "Alamat dinonaktifkan.");
  revalidateCustomer(customerId);
  return res;
}

export async function confirmProposalAction(customerId: string, addressId: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.confirmCoordinateProposal(ctx, addressId).then(() => undefined), "Koordinat dikunci dari lokasi Selesai rit.");
  revalidateCustomer(customerId);
  return res;
}

export async function rejectProposalAction(customerId: string, addressId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.rejectCoordinateProposal(ctx, addressId, reason).then(() => undefined), "Usulan koordinat ditolak.");
  revalidateCustomer(customerId);
  return res;
}

export async function deactivateCustomerAction(id: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.deactivateCustomer(ctx, id, reason).then(() => undefined), "Pelanggan dinonaktifkan.");
  revalidateCustomer(id);
  return res;
}

export async function reactivateCustomerAction(id: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.reactivateCustomer(ctx, id, reason).then(() => undefined), "Pelanggan diaktifkan kembali.");
  revalidateCustomer(id);
  return res;
}

export async function setStorePartnerAction(id: string, isStorePartner: boolean, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.setStorePartner(ctx, id, { isStorePartner, reason }).then(() => undefined), isStorePartner ? "Ditandai mitra toko." : "Penanda mitra toko dicabut.");
  revalidateCustomer(id);
  return res;
}

export async function requestCreditAction(id: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.requestCreditGrant(ctx, id, { reason }).then(() => undefined), "Pengajuan Tempo dikirim ke pemilik.");
  revalidateCustomer(id);
  return res;
}

export async function requestCreditTermsAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m1.requestCreditTermsChange(ctx, id, { creditLimit: int(fd, "creditLimit") ?? Number.NaN, paymentTermDays: int(fd, "paymentTermDays") ?? Number.NaN, reason: str(fd, "reason") ?? "" });
  }, "Pengajuan ubah batas/tempo dikirim ke pemilik.");
  revalidateCustomer(id);
  return res;
}

export async function requestSpecialPriceAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m1.requestSpecialPrice(ctx, { customerId: id, productId: str(fd, "productId") ?? "", price: int(fd, "price") ?? Number.NaN, validFrom: str(fd, "validFrom") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Harga khusus diajukan ke pemilik.");
  revalidateCustomer(id);
  return res;
}

export async function reviewSpecialPriceAction(specialPriceId: string, action: "keep" | "end", note: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.reviewSpecialPrice(ctx, specialPriceId, { action, note }).then(() => undefined), action === "keep" ? "Harga khusus tetap berlaku; tinjauan berikutnya dijadwalkan." : "Harga khusus diakhiri hari ini.");
  revalidatePath(base);
  return res;
}

export async function cancelApprovalAction(approvalId: string, customerId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => approvals.cancel(ctx, approvalId, reason).then(() => undefined), "Pengajuan dibatalkan.");
  revalidateCustomer(customerId);
  return res;
}
