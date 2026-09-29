/**
 * P3 — mitra depot EQUA (tenant mitra) dari sisi EQUA: daftar & rincian mitra, tautan pelanggan mitra ke tenant &
 * outlet (US-P3-08 KP-1, BR-18), serta akun & perangkat POS tenant mitra oleh admin sistem EQUA (backlog B-07 lewat
 * M10: `createUser({ tenantId })`, `registerDeviceForTenant`, `issueInitialPinForTenant`).
 *
 * NFR-30 / US-P3-02 KP-2: rincian mitra untuk EQUA hanya memuat data yang diperjanjikan (penjualan agregat, pasokan,
 * neraca air, tagihan, mutu). Daftar akun mitra hanya untuk admin sistem (administrasi akses), tanpa data transaksi.
 */
import "server-only";

import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { customers, devices, employees, invoices, outlets, partnerContracts, partnerSanctions, partnerSupportRequests, userRoles, users, waterSupplyReceipts } from "@/db/schema";
import { enumValues, label, type EnumValue, type RoleCode } from "@/lib/labels";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { authorize, authorizeAny, can, runService } from "@/server/core/rbac";
import { createUser, issueInitialPinForTenant, registerDeviceForTenant } from "@/server/modules/m10-access";

import {
  assertOwnerTenant,
  latestContractFor,
  loadPartnerTenant,
  monthKey,
  partnerCustomersOf,
  partnerTenants,
  partnerTerms,
  tenantOutlets,
  type ContractRow,
  type OutletRow,
  type TenantRow,
} from "./common";
import { partnerWaterBalance, type PartnerWaterBalanceRow } from "./supply";

/** Izin baca ringkasan mitra (salah satu). */
export const PARTNER_OVERVIEW_PERMISSIONS = ["p3.partner.read", "p3.partner_contract.read", "p3.partner_supply.read", "p3.subscription.read"] as const;

/** Hak baca EQUA yang diperjanjikan & ditampilkan ke mitra (US-P3-02 KP-2, NFR-30). */
export const EQUA_READ_RIGHTS = enumValues("partner_read_right").map((key) => ({ key, label: label("partner_read_right", key) }));

// =====================================================================================================================
// Daftar & rincian mitra
// =====================================================================================================================

export type PartnerListRow = {
  tenant: Pick<TenantRow, "id" | "code" | "name" | "isActive" | "readOnly" | "createdAt">;
  outlets: Pick<OutletRow, "id" | "code" | "name" | "isActive" | "activatedOn" | "billingStartDate">[];
  customers: { id: string; name: string; outletId: string | null; creditStatus: string; creditLimit: number }[];
  contract: Pick<ContractRow, "id" | "number" | "status" | "option" | "startDate" | "endDate" | "subscriptionFeePerOutlet" | "monthlyBilling"> | null;
  receivable: { outstanding: number; overdue: number };
  openSupport: number;
  pendingSupplies: number;
  activeSanctions: number;
};

export async function listPartners(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<PartnerListRow[]> {
  await authorizeAny(ctx, PARTNER_OVERVIEW_PERMISSIONS, { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const today = ctxBusinessDate(ctx);
  const out: PartnerListRow[] = [];
  for (const tenant of await partnerTenants(tx, { includeInactive: true })) {
    const outletRows = await tenantOutlets(tx, tenant.id);
    const cust = await partnerCustomersOf(tx, tenant.id);
    const contract = await latestContractFor(tx, tenant.id);
    const custIds = cust.map((c) => c.id);
    const inv = custIds.length
      ? await tx
          .select({
            outstanding: sql<string>`coalesce(sum(${invoices.outstandingAmount}), 0)`,
            overdue: sql<string>`coalesce(sum(case when ${invoices.dueDate} < ${today} then ${invoices.outstandingAmount} else 0 end), 0)`,
          })
          .from(invoices)
          .where(and(inArray(invoices.customerId, custIds), gt(invoices.outstandingAmount, 0)))
      : [{ outstanding: "0", overdue: "0" }];
    const [sup] = await tx
      .select({ n: count() })
      .from(partnerSupportRequests)
      .where(and(eq(partnerSupportRequests.tenantId, tenant.id), sql`${partnerSupportRequests.status} <> 'done'`));
    const [pend] = await tx
      .select({ n: count() })
      .from(waterSupplyReceipts)
      .where(and(eq(waterSupplyReceipts.tenantId, tenant.id), eq(waterSupplyReceipts.status, "arrived")));
    const [sanc] = await tx
      .select({ n: count() })
      .from(partnerSanctions)
      .where(and(eq(partnerSanctions.tenantId, tenant.id), eq(partnerSanctions.status, "active")));
    out.push({
      tenant: { id: tenant.id, code: tenant.code, name: tenant.name, isActive: tenant.isActive, readOnly: tenant.readOnly, createdAt: tenant.createdAt },
      outlets: outletRows.map((o) => ({ id: o.id, code: o.code, name: o.name, isActive: o.isActive, activatedOn: o.activatedOn, billingStartDate: o.billingStartDate })),
      customers: cust.map((c) => ({ id: c.id, name: c.name, outletId: c.partnerOutletId, creditStatus: c.creditStatus, creditLimit: c.creditLimit })),
      contract: contract
        ? {
            id: contract.id,
            number: contract.number,
            status: contract.status,
            option: contract.option,
            startDate: contract.startDate,
            endDate: contract.endDate,
            subscriptionFeePerOutlet: contract.subscriptionFeePerOutlet,
            monthlyBilling: contract.monthlyBilling,
          }
        : null,
      receivable: { outstanding: Number(inv[0]?.outstanding ?? 0), overdue: Number(inv[0]?.overdue ?? 0) },
      openSupport: Number(sup?.n ?? 0),
      pendingSupplies: Number(pend?.n ?? 0),
      activeSanctions: Number(sanc?.n ?? 0),
    });
  }
  return out;
}

export type PartnerAccountRow = { userId: string; username: string; fullName: string; status: string; roles: RoleCode[]; outletName: string | null };
export type PartnerDeviceRow = { id: string; deviceCode: string; name: string; status: string; outletName: string | null; lastSyncAt: Date | null };

export type PartnerDetail = {
  tenant: TenantRow;
  terms: Awaited<ReturnType<typeof partnerTerms>>;
  outlets: OutletRow[];
  customers: { id: string; code: string | null; name: string; outletId: string | null; segment: string; creditStatus: string; creditLimit: number; monthlyBilling: boolean }[];
  contracts: ContractRow[];
  waterBalance: PartnerWaterBalanceRow[];
  invoices: { id: string; number: string; kind: string; issueDate: string; dueDate: string; amount: number; outstandingAmount: number; status: string }[] | null;
  accounts: PartnerAccountRow[] | null;
  devices: PartnerDeviceRow[] | null;
  readRights: typeof EQUA_READ_RIGHTS;
};

/** Rincian mitra untuk EQUA (data yang diperjanjikan; akun & perangkat hanya untuk admin sistem). */
export async function getPartnerDetail(ctx: ActorContext, tenantId: string, opts: { tx?: Tx } = {}): Promise<PartnerDetail> {
  await authorizeAny(ctx, PARTNER_OVERVIEW_PERMISSIONS, { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const tenant = await loadPartnerTenant(tx, tenantId);
  const outletRows = await tenantOutlets(tx, tenant.id);
  const cust = await partnerCustomersOf(tx, tenant.id);
  const contracts = await tx.select().from(partnerContracts).where(eq(partnerContracts.tenantId, tenant.id)).orderBy(desc(partnerContracts.startDate));
  const month = monthKey(ctxBusinessDate(ctx));
  const custIds = cust.map((c) => c.id);
  const inv =
    can(ctx, "p3.subscription.read") && custIds.length
      ? await tx
          .select()
          .from(invoices)
          .where(inArray(invoices.customerId, custIds))
          .orderBy(desc(invoices.issueDate))
          .limit(24)
      : null;
  let accounts: PartnerAccountRow[] | null = null;
  if (can(ctx, "m10.user.read")) {
    const rows = await tx
      .select({ user: users, fullName: employees.fullName, primaryOutletId: employees.primaryOutletId })
      .from(users)
      .innerJoin(employees, eq(employees.id, users.employeeId))
      .where(eq(users.tenantId, tenant.id))
      .orderBy(asc(users.username));
    const roleRows = rows.length ? await tx.select().from(userRoles).where(inArray(userRoles.userId, rows.map((r) => r.user.id))) : [];
    accounts = rows.map((r) => ({
      userId: r.user.id,
      username: r.user.username,
      fullName: r.fullName,
      status: r.user.status,
      roles: roleRows.filter((x) => x.userId === r.user.id && (x.status === "active" || x.status === "pending")).map((x) => x.role as RoleCode),
      outletName: outletRows.find((o) => o.id === r.primaryOutletId)?.name ?? null,
    }));
  }
  let deviceRows: PartnerDeviceRow[] | null = null;
  if (can(ctx, "m10.device.read")) {
    const rows = await tx.select().from(devices).where(eq(devices.tenantId, tenant.id)).orderBy(asc(devices.deviceCode));
    deviceRows = rows.map((d) => ({ id: d.id, deviceCode: d.deviceCode, name: d.name, status: d.status, outletName: outletRows.find((o) => o.id === d.outletId)?.name ?? null, lastSyncAt: d.lastSyncAt }));
  }
  return {
    tenant,
    terms: await partnerTerms(tx),
    outlets: outletRows,
    customers: cust.map((c) => ({ id: c.id, code: c.code, name: c.name, outletId: c.partnerOutletId, segment: c.segment, creditStatus: c.creditStatus, creditLimit: c.creditLimit, monthlyBilling: c.monthlyBilling })),
    contracts,
    waterBalance: can(ctx, "p3.partner_supply.read") || can(ctx, "p3.partner.read") ? await partnerWaterBalance(tx, tenant.id, month) : [],
    invoices: inv ? inv.map((i) => ({ id: i.id, number: i.number, kind: i.kind, issueDate: i.issueDate, dueDate: i.dueDate, amount: i.amount, outstandingAmount: i.outstandingAmount, status: i.status })) : null,
    accounts,
    devices: deviceRows,
    readRights: EQUA_READ_RIGHTS,
  };
}

/** Pilihan tenant/outlet mitra & pelanggan kandidat (segmen depot pihak ketiga) untuk formulir tautan/kontrak. */
export async function partnerFormOptions(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["p3.partner_customer.link", "p3.partner_contract.create", "p3.partner_contract.read", "m10.user.create"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const tenantsList = await partnerTenants(tx);
  const outletList = tenantsList.length
    ? await tx
        .select({ id: outlets.id, tenantId: outlets.tenantId, code: outlets.code, name: outlets.name })
        .from(outlets)
        .where(and(inArray(outlets.tenantId, tenantsList.map((t) => t.id)), eq(outlets.kind, "depot")))
        .orderBy(asc(outlets.code))
    : [];
  const candidates = await tx
    .select({ id: customers.id, code: customers.code, name: customers.name, isEquaPartner: customers.isEquaPartner, partnerTenantId: customers.partnerTenantId })
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.segment, "third_party_depot"), eq(customers.isActive, true), sql`${customers.internalOutletId} is null`))
    .orderBy(asc(customers.name));
  return {
    tenants: tenantsList.map((t) => ({ id: t.id, code: t.code, name: t.name })),
    outlets: outletList,
    customers: candidates,
  };
}

// =====================================================================================================================
// KP-1: tautan pelanggan mitra ↔ tenant & outlet mitra
// =====================================================================================================================

const reasonSchema = z.string().trim().min(5, { error: "Alasan/dasar perjanjian wajib diisi (minimal 5 karakter)." }).max(500);

const linkSchema = z.object({
  customerId: z.uuid({ error: "Pilih pelanggan (segmen depot pihak ketiga)." }),
  tenantId: z.uuid({ error: "Pilih tenant mitra." }),
  outletId: z.uuid({ error: "Pilih outlet depot mitra." }),
  reason: reasonSchema,
});

/**
 * US-P3-08 KP-1: pelanggan M1 (segmen depot pihak ketiga) ditandai mitra depot EQUA + mitra toko manual (BR-18) dan
 * ditautkan ke tenant & outlet mitra — pesanan air selanjutnya di M2 seperti pelanggan biasa (harga zona Opsi B).
 */
export async function linkPartnerCustomer(ctx: ActorContext, input: z.input<typeof linkSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_customer.link", { tx: opts.tx, objectType: "customer", objectId: input?.customerId });
  const data = parseInput(linkSchema, input, { customerId: "Pelanggan", tenantId: "Tenant mitra", outletId: "Outlet mitra", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const [c] = await tx.select().from(customers).where(eq(customers.id, data.customerId)).for("update").limit(1);
    if (!c || c.tenantId !== ctx.tenantId) throw new NotFoundError("Pelanggan tidak ditemukan.");
    if (!c.isActive) throw new DomainError("CUSTOMER_INACTIVE", `Pelanggan ${c.name} nonaktif. Aktifkan dulu di Data master > Pelanggan.`);
    if (c.segment !== "third_party_depot") {
      throw ValidationError.field("customerId", "Pelanggan mitra depot EQUA harus bersegmen depot pihak ketiga (US-P3-08 KP-1). Ubah segmen di Data master bila perlu.");
    }
    if (c.internalOutletId) throw ValidationError.field("customerId", "Pelanggan internal depot EQUA tidak dapat menjadi mitra.");
    const tenant = await loadPartnerTenant(tx, data.tenantId);
    if (!tenant.isActive) throw new DomainError("TENANT_INACTIVE", `Tenant ${tenant.name} sudah nonaktif.`);
    const [o] = await tx.select().from(outlets).where(eq(outlets.id, data.outletId)).limit(1);
    if (!o || o.tenantId !== tenant.id || o.kind !== "depot") throw ValidationError.field("outletId", "Outlet depot tidak ditemukan pada tenant mitra ini.");
    const [taken] = await tx
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(eq(customers.partnerOutletId, o.id), eq(customers.isEquaPartner, true), sql`${customers.id} <> ${c.id}`))
      .limit(1);
    if (taken) throw new DomainError("OUTLET_ALREADY_LINKED", `Outlet ${o.name} sudah tertaut ke pelanggan ${taken.name}. Satu outlet mitra = satu pelanggan mitra.`);
    const before = { isEquaPartner: c.isEquaPartner, partnerTenantId: c.partnerTenantId, partnerOutletId: c.partnerOutletId, isStorePartner: c.isStorePartner, storePartnerSource: c.storePartnerSource };
    const after = { isEquaPartner: true, partnerTenantId: tenant.id, partnerOutletId: o.id, isStorePartner: true, storePartnerSource: "manual" as const };
    const [row] = await tx
      .update(customers)
      .set({ ...after, updatedAt: ctx.now })
      .where(eq(customers.id, c.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "customer", objectId: c.id, action: "update", before, after: { ...after, tenantName: tenant.name, outletName: o.name }, reason: data.reason, rule: "US-P3-08 KP-1, BR-18" });
    return row!;
  });
}

// =====================================================================================================================
// B-07: akun & perangkat tenant mitra (admin sistem EQUA)
// =====================================================================================================================

const operatorSchema = z
  .object({
    tenantId: z.uuid({ error: "Pilih tenant mitra." }),
    outletId: z.uuid({ error: "Pilih outlet mitra." }).nullable().optional(),
    fullName: z.string().trim().min(3, { error: "Nama lengkap minimal 3 karakter." }).max(120),
    phone: z.string().trim().max(30).nullable().optional(),
    username: z.string().trim().toLowerCase().min(3).max(40),
    role: z.enum(["depot_operator", "partner_owner"], { error: "Peran akun mitra: Operator depot (POS) atau Pemilik mitra (portal)." }),
    reason: reasonSchema,
  })
  .refine((v) => v.role !== "depot_operator" || !!v.outletId, { error: "Operator depot wajib diberi outlet mitra.", path: ["outletId"] });

export type RegisterPartnerOperatorInput = z.input<typeof operatorSchema>;

/**
 * B-07: admin sistem EQUA membuat karyawan + akun untuk tenant mitra (operator POS berlingkup outlet mitra, atau pemilik
 * mitra berlingkup tenant mitra). Akun berstatus Menunggu persetujuan dan aktif setelah pemilik EQUA menyetujui
 * (`account_create`, US-M10-01 KP-8 → US-P3-10 KP-1).
 */
export async function registerPartnerOperator(ctx: ActorContext, input: RegisterPartnerOperatorInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.user.create", { tx: opts.tx, objectType: "user" });
  const data = parseInput(operatorSchema, input, { fullName: "Nama lengkap", username: "Nama pengguna", role: "Peran", reason: "Alasan", outletId: "Outlet" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const tenant = await loadPartnerTenant(tx, data.tenantId);
    if (!tenant.isActive) throw new DomainError("TENANT_INACTIVE", `Tenant ${tenant.name} sudah nonaktif.`);
    let outlet: OutletRow | null = null;
    if (data.outletId) {
      const [o] = await tx.select().from(outlets).where(eq(outlets.id, data.outletId)).limit(1);
      if (!o || o.tenantId !== tenant.id) throw ValidationError.field("outletId", "Outlet tidak ditemukan pada tenant mitra ini.");
      outlet = o;
    }
    const [{ n }] = (await tx.select({ n: count() }).from(employees).where(eq(employees.tenantId, tenant.id))) as [{ n: number }];
    const employeeNo = `${tenant.code}-${String(Number(n) + 1).padStart(3, "0")}`;
    const role = data.role as EnumValue<"role">;
    const [emp] = await tx
      .insert(employees)
      .values({
        tenantId: tenant.id,
        employeeNo,
        fullName: data.fullName,
        position: label("role", role),
        phone: data.phone ?? null,
        workLocation: outlet?.name ?? tenant.name,
        primaryOutletId: outlet?.id ?? null,
        intendedRoles: [role],
        createdBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "employee", objectId: emp!.id, action: "create", after: { employeeNo, fullName: data.fullName, tenantId: tenant.id, tenantName: tenant.name }, reason: data.reason, rule: "B-07" });
    const scopes = role === "partner_owner" ? [{ type: "tenant" as const, refId: tenant.id }] : [{ type: "outlet" as const, refId: outlet!.id }];
    const res = await createUser(ctx, { employeeId: emp!.id, username: data.username, role, scopes, reason: data.reason, tenantId: tenant.id }, { tx });
    return { employee: emp!, user: res.user, approval: res.approval };
  });
}

const deviceSchema = z.object({
  tenantId: z.uuid({ error: "Pilih tenant mitra." }),
  outletId: z.uuid({ error: "Pilih outlet mitra." }),
  deviceCode: z.string().trim().min(2).max(60),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["tablet", "phone"]).default("tablet"),
});

/** B-07: daftarkan tablet POS outlet mitra → kode aktivasi (sekali tampil). */
export async function registerPartnerDevice(ctx: ActorContext, input: z.input<typeof deviceSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.device.register", { tx: opts.tx, objectType: "device" });
  const data = parseInput(deviceSchema, input, { deviceCode: "Kode perangkat", name: "Nama perangkat", outletId: "Outlet" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const tenant = await loadPartnerTenant(tx, data.tenantId);
    const [o] = await tx.select().from(outlets).where(eq(outlets.id, data.outletId)).limit(1);
    if (!o || o.tenantId !== tenant.id) throw ValidationError.field("outletId", "Outlet tidak ditemukan pada tenant mitra ini.");
    return registerDeviceForTenant(ctx, { tenantId: tenant.id, deviceCode: data.deviceCode, name: data.name, kind: data.kind, outletId: o.id }, { tx });
  });
}

/** B-07: kode aktivasi PIN pertama operator mitra (ditetapkan operator sendiri di tablet POS). */
export async function issuePartnerOperatorPin(ctx: ActorContext, input: { tenantId: string; userId: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m10.user.reset_pin", { tx: opts.tx, objectType: "user", objectId: input.userId });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    await loadPartnerTenant(tx, input.tenantId);
    return issueInitialPinForTenant(ctx, input, { tx });
  });
}
