/**
 * RBAC & pemisahan tugas — API publik.
 *
 * ```ts
 * import { authorize, assertOutletScope, sod } from "@/server/core/rbac";
 * await authorize(ctx, "m6.pos_sale.void");
 * await assertOutletScope(getDb(), ctx, outletId);
 * sod.assertNotSelf(req.requesterUserId, ctx.userId);
 * ```
 */
import "server-only";

export * from "./authorize";
export * from "./matrix";
export * from "./permissions";
export * from "./roles";
export * as sod from "./sod";
