import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { receivableReminders, waMessageLogs, waTemplates } from "@/db/schema";
import { EQUA_TENANT_ID } from "@/db/seed";
import { formatRupiah } from "@/lib/money";
import { addDays } from "@/lib/time";
import { withTx } from "@/server/core/db";
import type { WhatsAppProvider } from "@/server/core/wa";
import * as m5 from "@/server/modules/m5-receivables";
import { generateReminders } from "@/server/modules/m5-receivables/service/reminders";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { accountant, creditCustomer, dispatcher, finance, invoiceFor, notificationsFor, owner, system, today } from "./helpers";

/** Penyedia WhatsApp Cloud API tiruan (Tahap 2, US-P2-08) — mencatat pesan yang "terkirim". */
function fakeCloudApi(): WhatsAppProvider & { sent: { to: string; text: string }[] } {
  const sent: { to: string; text: string }[] = [];
  return {
    kind: "cloud_api",
    sent,
    async send(req) {
      sent.push({ to: req.to, text: req.text });
      return { mode: "cloud_api", status: "sent", providerMessageId: `wamid.${sent.length}` };
    },
  };
}

describe("US-M5-05 Pengingat jatuh tempo lewat WA", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M5-05 KP-1 daftar harian H-3 & H+1 (PAR-13) per pelanggan dengan total sisa; tombol membuka WA dengan template terisi (nomor faktur, jumlah, jatuh tempo, rekening PT); status 'dibuka' tercatat", async () => {
    const d = today();
    const a = await creditCustomer(t.db, { name: "Hotel Pengingat A" });
    const b = await creditCustomer(t.db, { name: "Resto Pengingat B" });
    const i1 = await invoiceFor(t.db, a.id, { amount: 150_000, issueDate: addDays(d, -11), dueDate: addDays(d, 3) });
    const i2 = await invoiceFor(t.db, a.id, { amount: 250_000, issueDate: addDays(d, -10), dueDate: addDays(d, 3) });
    const i3 = await invoiceFor(t.db, b.id, { amount: 300_000, issueDate: addDays(d, -15), dueDate: addDays(d, -1) });
    // Tidak masuk daftar hari ini: jatuh tempo H-2 dan H+5.
    await invoiceFor(t.db, b.id, { amount: 99_000, issueDate: d, dueDate: addDays(d, 2) });
    await invoiceFor(t.db, b.id, { amount: 98_000, issueDate: addDays(d, -20), dueDate: addDays(d, -5) });

    const { groups } = await m5.listReminders(finance());
    const ga = groups.find((g) => g.customerId === a.id)!;
    expect(ga).toMatchObject({ kind: "before_due", total: 400_000, status: "scheduled" });
    expect(ga.invoices.map((i) => i.id).sort()).toEqual([i1.id, i2.id].sort());
    const gb = groups.find((g) => g.customerId === b.id)!;
    expect(gb).toMatchObject({ kind: "after_due", total: 300_000 });
    expect(gb.invoices.map((i) => i.id)).toEqual([i3.id]);

    const res = await m5.openReminder(finance(), { customerId: a.id, kind: "before_due" });
    expect(res.link).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(res.text).toContain(i1.number);
    expect(res.text).toContain(i2.number);
    expect(res.text).toContain(formatRupiah(400_000));
    expect(res.text).toMatch(/jatuh tempo/);
    expect(res.text).toContain("0012345678"); // rekening PT (seed)
    const rows = await t.db.select().from(receivableReminders).where(eq(receivableReminders.customerId, a.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "opened" && r.openedAt && r.waMessageLogId)).toBe(true);
    const [log] = await t.db.select().from(waMessageLogs).where(and(eq(waMessageLogs.customerId, a.id), eq(waMessageLogs.kind, "reminder_before_due")));
    expect(log).toMatchObject({ status: "link_opened" });
    const after = await m5.listReminders(finance());
    expect(after.groups.find((g) => g.customerId === a.id)!.status).toBe("opened");
    // H+1 memakai template sesudah jatuh tempo.
    const late = await m5.openReminder(finance(), { customerId: b.id, kind: "after_due" });
    expect(late.text).toMatch(/telah jatuh tempo/);
    // Dispatcher tidak mengirim pengingat piutang; akuntan hanya membaca? — keduanya tidak boleh membuka WA.
    await expect(m5.openReminder(dispatcher(), { customerId: a.id, kind: "before_due" })).rejects.toThrow();
  });

  it("US-M5-05 KP-1 job harian mencatat pengingat Dijadwalkan (idempoten) dan memberi tahu Admin Keuangan", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Pabrik Dijadwalkan" });
    const inv = await invoiceFor(t.db, c.id, { amount: 500_000, issueDate: addDays(d, -11), dueDate: addDays(d, 3) });
    const first = await withTx((tx) => generateReminders(tx, system(d), EQUA_TENANT_ID, d));
    expect(first.scheduled).toBeGreaterThanOrEqual(1);
    const again = await withTx((tx) => generateReminders(tx, system(d), EQUA_TENANT_ID, d));
    expect(again.scheduled).toBe(0);
    const rows = await t.db.select().from(receivableReminders).where(eq(receivableReminders.invoiceId, inv.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "before_due", status: "scheduled", scheduledDate: d, totalOutstanding: 500_000 });
    const notes = await notificationsFor(t.db, "receivable.reminder_due");
    expect(notes.some((n) => n.link === `/piutang/pengingat?tanggal=${d}`)).toBe(true);
  });

  it("US-M5-05 KP-2 template dikelola pemilik (versi baru, wajib memuat variabel inti); Admin Keuangan tidak dapat mengubah", async () => {
    const d = today();
    const body = "Halo {{nama_pelanggan}}, faktur {{nomor_faktur}} ({{jumlah}}) jatuh tempo {{jatuh_tempo}}. Transfer ke {{rekening}}. Salam EQUA.";
    await expect(m5.updateReceivableTemplate(finance(), { kind: "reminder_before_due", body, reason: "Ubah gaya bahasa" })).rejects.toThrow();
    await expect(
      m5.updateReceivableTemplate(owner(), { kind: "reminder_before_due", body: "Halo {{nama_pelanggan}}, mohon segera bayar faktur {{nomor_faktur}}.", reason: "Coba" }),
    ).rejects.toThrow(/wajib memuat/);
    const before = (await m5.listReceivableTemplates(finance())).find((x) => x.kind === "reminder_before_due")!;
    const v1 = await m5.updateReceivableTemplate(owner(), { kind: "reminder_before_due", body, reason: "Ubah gaya bahasa" });
    expect(v1).toMatchObject({ version: before.version + 1, isActive: true });
    const v2 = await m5.updateReceivableTemplate(owner(), { kind: "reminder_before_due", body: body.replace("Halo", "Yth."), reason: "Lebih sopan" });
    expect(v2.version).toBe(v1.version + 1);
    const all = await t.db.select().from(waTemplates).where(and(eq(waTemplates.tenantId, EQUA_TENANT_ID), eq(waTemplates.kind, "reminder_before_due")));
    expect(all.filter((r) => r.isActive)).toHaveLength(1);
    expect(all.find((r) => r.version === v1.version)!.isActive).toBe(false);
    const list = await m5.listReceivableTemplates(finance());
    expect(list.find((x) => x.kind === "reminder_before_due")).toMatchObject({ version: v2.version, isDefault: false });
    // Pengingat berikutnya memakai template pemilik.
    const c = await creditCustomer(t.db, { name: "Kafe Template" });
    await invoiceFor(t.db, c.id, { amount: 120_000, issueDate: addDays(d, -11), dueDate: addDays(d, 3) });
    const res = await m5.openReminder(finance(), { customerId: c.id, kind: "before_due" });
    expect(res.text.startsWith("Yth. Kafe Template")).toBe(true);
    expect(res.text).toContain("Salam EQUA");
    // Akuntan boleh melihat daftar template (baca-saja) tetapi tidak mengubah.
    await expect(m5.updateReceivableTemplate(accountant(), { kind: "statement", body: "Saldo {{saldo}} per {{tanggal}} mohon dicek.", reason: "Uji" })).rejects.toThrow();
  });

  it("US-M5-05 KP-2 WhatsApp Business API aktif → pengingat terkirim otomatis oleh job tanpa mengubah alur (status tercatat)", async () => {
    const d = today();
    const c = await creditCustomer(t.db, { name: "Hotel Otomatis" });
    const inv = await invoiceFor(t.db, c.id, { amount: 700_000, issueDate: addDays(d, -15), dueDate: addDays(d, -1) });
    const provider = fakeCloudApi();
    const res = await withTx((tx) => generateReminders(tx, system(d), EQUA_TENANT_ID, d, { provider }));
    expect(res.autoSent).toBeGreaterThanOrEqual(1);
    expect(provider.sent.some((s) => s.text.includes(inv.number))).toBe(true);
    const [row] = await t.db.select().from(receivableReminders).where(eq(receivableReminders.invoiceId, inv.id));
    expect(row).toMatchObject({ status: "opened", kind: "after_due" });
    const [log] = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.id, row!.waMessageLogId!));
    expect(log).toMatchObject({ provider: "cloud_api", status: "sent", customerId: c.id });
    // Daftar harian tetap sama (status dibuka) — tidak ada perubahan alur bagi Admin Keuangan.
    const { groups } = await m5.listReminders(finance());
    expect(groups.find((g) => g.customerId === c.id)!.status).toBe("opened");
  });

  it("US-M5-05 KP-3 pelanggan tagihan bulanan diingatkan berdasarkan faktur bulanan; faktur bersengketa tidak diingatkan sampai diputuskan", async () => {
    const d = today();
    const monthly = await creditCustomer(t.db, { name: "Hotel Bulanan Ingat", monthly: true });
    const perTrip = await invoiceFor(t.db, monthly.id, { amount: 90_000, issueDate: addDays(d, -11), dueDate: addDays(d, 3), kind: "underpayment" });
    const mInv = await invoiceFor(t.db, monthly.id, { amount: 2_500_000, issueDate: addDays(d, -12), dueDate: addDays(d, 3), kind: "monthly" });
    const { groups } = await m5.listReminders(finance());
    const g = groups.find((x) => x.customerId === monthly.id)!;
    expect(g.invoices.map((i) => i.id)).toEqual([mInv.id]);
    expect(g.invoices.some((i) => i.id === perTrip.id)).toBe(false);

    const disputedCustomer = await creditCustomer(t.db, { name: "Resto Sengketa Ingat" });
    const dInv = await invoiceFor(t.db, disputedCustomer.id, { amount: 400_000, issueDate: addDays(d, -15), dueDate: addDays(d, -1) });
    await m5.disputeInvoice(finance(), { invoiceId: dInv.id, note: "Pelanggan: volume kurang 1.000 L" });
    const after = await m5.listReminders(finance());
    const gd = after.groups.find((x) => x.customerId === disputedCustomer.id)!;
    expect(gd).toMatchObject({ status: "skipped", total: 0 });
    expect(gd.invoices[0]!.skipReason).toMatch(/bersengketa/);
    await expect(m5.openReminder(finance(), { customerId: disputedCustomer.id, kind: "after_due" })).rejects.toThrow(/bersengketa/);
    const run = await withTx((tx) => generateReminders(tx, system(d), EQUA_TENANT_ID, d));
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    const [row] = await t.db.select().from(receivableReminders).where(eq(receivableReminders.invoiceId, dInv.id));
    expect(row).toMatchObject({ status: "skipped" });
    // Sengketa ditolak pemilik → faktur kembali masuk daftar pengingat.
    await m5.decideDispute(owner(), { invoiceId: dInv.id, decision: "reject", reason: "Volume sesuai catatan rit" });
    const resumed = await m5.listReminders(finance());
    expect(resumed.groups.find((x) => x.customerId === disputedCustomer.id)).toMatchObject({ status: "scheduled", total: 400_000 });
  });
});
