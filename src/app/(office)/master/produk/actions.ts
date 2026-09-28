"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import type { PriceKind, ProductLine } from "@/lib/labels";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, bool, int, str } from "../_lib/form";

const base = "/master/produk";

export async function createProductAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m1.createProduct(ctx, {
      code: str(fd, "code") ?? "",
      name: str(fd, "name") ?? "",
      line: (str(fd, "line") ?? "depot") as ProductLine,
      unit: str(fd, "unit") ?? "",
      category: str(fd, "category"),
      gallonSizeL: int(fd, "gallonSizeL"),
      isConsumable: bool(fd, "isConsumable"),
      isInternalTransfer: bool(fd, "isInternalTransfer"),
      posVisible: !bool(fd, "hideFromPos"),
      sortOrder: int(fd, "sortOrder") ?? 0,
    });
  }, "Produk dibuat. Tetapkan harganya.");
  revalidatePath(base);
  return res;
}

/** Harga produk: Admin Keuangan mengajukan (persetujuan pemilik); pemilik menetapkan langsung (6.2b). */
export async function proposeProductPriceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  let status: string | undefined;
  const res = await attempt(async () => {
    const r = await m1.proposeProductPrice(ctx, {
      productId: str(fd, "productId") ?? "",
      kind: (str(fd, "kind") ?? "standard") as PriceKind,
      outletId: str(fd, "outletId"),
      price: int(fd, "price") ?? Number.NaN,
      effectiveFrom: str(fd, "effectiveFrom") ?? "",
      reason: str(fd, "reason") ?? "",
    });
    status = r.status;
  });
  revalidatePath(base);
  return res.ok ? { ...res, message: status === "active" ? "Harga baru ditetapkan (keputusan langsung pemilik)." : "Usulan harga dikirim ke pemilik." } : res;
}

export async function proposeFuelAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  let status: string | undefined;
  const res = await attempt(async () => {
    const r = await m1.proposeFuelComponent(ctx, { amountPerTrip: int(fd, "amountPerTrip") ?? Number.NaN, effectiveFrom: str(fd, "effectiveFrom") ?? "", reason: str(fd, "reason") ?? "" });
    status = r.status;
  });
  revalidatePath(base);
  revalidatePath("/master/zona");
  return res.ok ? { ...res, message: status === "active" ? "Komponen BBM baru ditetapkan." : "Usulan komponen BBM dikirim ke pemilik." } : res;
}

export async function setProductActiveAction(productId: string, active: boolean, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.setProductActive(ctx, productId, { active, reason }).then(() => undefined), active ? "Produk diaktifkan." : "Produk dinonaktifkan.");
  revalidatePath(base);
  return res;
}
