/**
 * B-53 — setiap rekening bank PT wajib punya akun buku sendiri (`bank_accounts.gl_account_id` terisi & tidak dipakai
 * bersama) agar rekonsiliasi bank M11 per rekening memakai saldo buku rekening itu (US-M11-06 KP-1, US-M4-05 KP-1).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { accounts, bankAccounts } from "@/db/schema";
import { EQUA_TENANT_ID, seedId } from "@/db/seed";
import { accountId } from "@/db/seed/accounting";
import * as m11 from "@/server/modules/m11-accounting";
import * as m4 from "@/server/modules/m4-cash";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { finance, owner } from "./helpers";

describe("B-53 akun buku per rekening bank", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("B-53 US-M4-05 KP-1 US-M11-06 KP-1 rekening baru tanpa pilihan → akun buku baru 1-12NN otomatis (kas/bank, berjejak); akun rekening lain ditolak", async () => {
    // Seed: rekening operasional memakai 1-1201 sendiri (migrasi seed).
    const [seedBank] = await t.db.select().from(bankAccounts).where(eq(bankAccounts.id, seedId("bank_account:operasional")));
    expect(seedBank!.glAccountId).toBe(accountId("1-1201"));
    expect(await m4.bankAccountsNeedingGl(t.db, EQUA_TENANT_ID)).toEqual([]);

    const bri = await m4.createBankAccount(finance(), { bankName: "BRI", accountNumber: "0021-01-000555-30-1", accountName: "PT EQUA Tirta" });
    const [gl] = await t.db.select().from(accounts).where(eq(accounts.id, bri.glAccountId!));
    expect(gl).toMatchObject({ type: "asset", isCash: true, isPostable: true, isActive: true, profitCenter: "SHARED" });
    expect(gl!.code).toMatch(/^1-12\d\d$/);
    expect(gl!.code).not.toBe("1-1201");
    expect(gl!.name).toContain("BRI");

    // Memilih akun yang sudah dipakai rekening lain → ditolak dengan pesan tindakan.
    await expect(m4.createBankAccount(finance(), { bankName: "BNI", accountNumber: "0987650001", accountName: "PT EQUA Tirta", glAccountId: accountId("1-1201") })).rejects.toThrow(
      /sudah dipakai rekening Bank Demo 0012345678.*akun buku sendiri/,
    );
    // Akun bukan kas/bank (piutang) ditolak.
    await expect(m4.createBankAccount(finance(), { bankName: "BNI", accountNumber: "0987650001", accountName: "PT EQUA Tirta", glAccountId: accountId("1-1401") })).rejects.toThrow(/bukan akun kas\/bank/);
    // Memilih akun bank bebas yang ada di bagan akun.
    const free = await m11.createAccount(finance(), { code: "1-1250", name: "Bank BNI operasional", type: "asset", isCash: true, profitCenter: "SHARED", parentCode: "1-1000" });
    const bni = await m4.createBankAccount(finance(), { bankName: "BNI", accountNumber: "0987650001", accountName: "PT EQUA Tirta", glAccountId: free.id });
    expect(bni.glAccountId).toBe(free.id);
    // Rekening berikutnya tanpa pilihan melanjutkan nomor tertinggi (1-1251).
    const bca = await m4.createBankAccount(finance(), { bankName: "BCA", accountNumber: "7770001112", accountName: "PT EQUA Tirta" });
    expect((await t.db.select({ code: accounts.code }).from(accounts).where(eq(accounts.id, bca.glAccountId!)))[0]!.code).toBe("1-1251");
    // Pilihan layar: akun yang sudah dipakai ditandai pemakainya.
    const opts = await m4.bankGlChoices(finance());
    expect(opts.options.find((o) => o.id === free.id)!.usedBy.map((u) => u.label)).toEqual(["BNI 0987650001"]);
    // Indeks unik DB menolak pemakaian bersama walau lewat jalur langsung.
    const err = await t.db
      .update(bankAccounts)
      .set({ glAccountId: free.id })
      .where(eq(bankAccounts.id, bca.id))
      .catch((e: unknown) => e);
    expect(String((err as { cause?: unknown })?.cause ?? err)).toMatch(/bank_accounts_gl_account_uq|duplicate/);
  });

  it("B-53 rekening lama tanpa akun buku sendiri ditandai lalu ditetapkan (berjejak, alasan wajib); hanya Admin Keuangan", async () => {
    const [legacy] = await t.db.insert(bankAccounts).values({ tenantId: EQUA_TENANT_ID, bankName: "Mandiri", accountNumber: "1320000999", accountName: "PT EQUA Tirta" }).returning();
    expect(await m4.bankAccountsNeedingGl(t.db, EQUA_TENANT_ID)).toEqual([{ id: legacy!.id, label: "Mandiri 1320000999", reason: "missing" }]);
    await expect(m4.setBankAccountGlAccount(owner(), { bankAccountId: legacy!.id, reason: "Migrasi akun buku" })).rejects.toThrow();
    await expect(m4.setBankAccountGlAccount(finance(), { bankAccountId: legacy!.id, glAccountId: accountId("1-1201"), reason: "Migrasi akun buku" })).rejects.toThrow(/sudah dipakai/);
    const fixed = await m4.setBankAccountGlAccount(finance(), { bankAccountId: legacy!.id, reason: "Migrasi akun buku per rekening (B-53)" });
    expect(fixed.glAccountId).not.toBeNull();
    expect(await m4.bankAccountsNeedingGl(t.db, EQUA_TENANT_ID)).toEqual([]);
  });
});
