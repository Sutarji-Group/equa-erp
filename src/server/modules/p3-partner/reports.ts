/**
 * P3 — laporan Kemitraan yang dapat diekspor Excel/PDF (`/api/export/<kunci>`; US-M9-03, NFR-23).
 *
 * RL-7: daftar mitra, pasokan & neraca air per mitra, pesanan air lewat SLA, faktur langganan mitra, permintaan
 * dukungan, laporan bulanan mitra (PDF, US-P3-10 KP-3), penjualan harian outlet mitra & riwayat pembelian (portal).
 * Tahap 3: calon mitra, kontrak, sanksi, skor mutu, dashboard kinerja, portofolio pembina, ekonomi kemitraan, rincian
 * royalti, ekspor data outlet mitra yang berakhir (PTB-58).
 *
 * Laporan portal selalu berlingkup tenant pelaku (NFR-30); pengguna EQUA memilih mitra lewat filter `tenantId`.
 */
import "server-only";

import { z } from "zod";

import { label } from "@/lib/labels";
import { isBusinessDate } from "@/lib/time";
import { NotFoundError, ValidationError } from "@/server/core/errors";
import { registerReport } from "@/server/core/export";

import { royaltyDetail, subscriptionBoard } from "./service/billing";
import { assertPortalEnabled, isValidMonth, loadTenant } from "./service/common";
import { listContracts } from "./service/contracts";
import { coachPortfolio, partnerDashboard, partnershipEconomics } from "./service/dashboard";
import { buildMonthlyReportData } from "./service/monthly-report";
import { listPartners } from "./service/partners";
import { partnerPurchaseHistory } from "./service/supply";
import { portalMonthlyReport, portalPurchaseHistory, portalSalesReport } from "./service/portal";
import { listProspects } from "./service/prospects";
import { qualityBoard } from "./service/quality";
import { listSanctions, partnerDataForExport } from "./service/sanctions";
import { supplyBoard } from "./service/supply";
import { listSupportRequests } from "./service/support";

const month = z.string().refine(isValidMonth, { error: "Bulan harus YYYY-MM." }).optional();
const monthFilter = z.object({ month, tenantId: z.uuid().optional() });
type MonthFilter = z.infer<typeof monthFilter>;
const describeMonth = (f: MonthFilter) => [f.month ? `Bulan: ${f.month}` : "Bulan berjalan", ...(f.tenantId ? ["Satu mitra"] : [])];

export function registerReports(): void {
  // ------------------------------------------------------------------------------------------------ RL-7 (EQUA)
  registerReport({
    key: "p3.partners",
    title: "Daftar mitra depot EQUA",
    module: "p3",
    permission: "p3.partner.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "code", header: "Kode", width: 8 },
      { key: "name", header: "Mitra", width: 24 },
      { key: "outlets", header: "Outlet", type: "number", width: 8 },
      { key: "contract", header: "Kontrak", width: 14 },
      { key: "contractStatus", header: "Status kontrak", width: 14 },
      { key: "outstanding", header: "Piutang", type: "rupiah", total: true, width: 14 },
      { key: "overdue", header: "Lewat tempo", type: "rupiah", total: true, width: 14 },
      { key: "openSupport", header: "Dukungan terbuka", type: "number", width: 10 },
      { key: "activeSanctions", header: "Sanksi berlaku", type: "number", width: 10 },
      { key: "readOnly", header: "Baca-saja", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, _f, { tx }) => ({
      rows: (await listPartners(ctx, { tx })).map((r) => ({
        code: r.tenant.code,
        name: r.tenant.name,
        outlets: r.outlets.length,
        contract: r.contract?.number ?? "-",
        contractStatus: r.contract ? label("partner_contract_status", r.contract.status) : "-",
        outstanding: r.receivable.outstanding,
        overdue: r.receivable.overdue,
        openSupport: r.openSupport,
        activeSanctions: r.activeSanctions,
        readOnly: r.tenant.readOnly,
      })),
    }),
  });

  registerReport({
    key: "p3.partner_supply",
    title: "Pasokan air & neraca air per mitra (bulanan)",
    module: "p3",
    permission: "p3.partner_supply.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthFilter,
    describeFilters: describeMonth,
    columns: [
      { key: "tenantName", header: "Mitra", width: 20 },
      { key: "ordersTotal", header: "Pesanan air", type: "number", total: true, width: 9 },
      { key: "ordersLate", header: "Lewat SLA", type: "number", total: true, width: 9 },
      { key: "tripsCompleted", header: "Rit Selesai", type: "number", total: true, width: 9 },
      { key: "deliveredL", header: "Air dikirim", type: "liter", total: true, width: 11 },
      { key: "receivedL", header: "Air diterima", type: "liter", total: true, width: 11 },
      { key: "differenceL", header: "Selisih kirim–terima", type: "liter", total: true, width: 11 },
      { key: "gallons", header: "Galon terjual", type: "number", total: true, width: 10 },
      { key: "salesTotal", header: "Omzet POS", type: "rupiah", total: true, width: 14 },
      { key: "exceeded", header: "Neraca di luar toleransi", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, f: MonthFilter, { tx }) => {
      const b = await supplyBoard(ctx, { month: f.month ?? null, tenantId: f.tenantId ?? null }, { tx });
      return {
        rows: b.rows.map((r) => ({
          tenantName: r.tenant.name,
          ordersTotal: r.orders.total,
          ordersLate: r.orders.late,
          tripsCompleted: r.tripsCompleted,
          deliveredL: r.deliveredL,
          receivedL: r.receipts.receivedL,
          differenceL: r.receipts.differenceL,
          gallons: r.sales.gallons,
          salesTotal: r.sales.salesTotal,
          exceeded: r.exceeded,
        })),
        summary: [{ label: "Bulan", value: b.month }],
      };
    },
  });

  registerReport({
    key: "p3.partner_water_balance",
    title: "Neraca air outlet mitra (galon × 19 L vs air diterima EQUA)",
    module: "p3",
    permission: "p3.partner_supply.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: monthFilter,
    describeFilters: describeMonth,
    columns: [
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "outletName", header: "Outlet", width: 18 },
      { key: "openingL", header: "Stok awal", type: "liter", width: 10 },
      { key: "receivedFromEquaL", header: "Air dari EQUA", type: "liter", total: true, width: 11 },
      { key: "otherSourceL", header: "Sumber lain", type: "liter", total: true, width: 10 },
      { key: "gallonsSold", header: "Galon terjual", type: "number", total: true, width: 10 },
      { key: "soldL", header: "Liter terjual", type: "liter", total: true, width: 11 },
      { key: "excessPct", header: "Kelebihan %", type: "percent", width: 9 },
      { key: "tolerancePct", header: "Toleransi % (PAR-79)", type: "percent", width: 9 },
      { key: "exceeded", header: "Di luar toleransi", type: "boolean", width: 9 },
    ],
    fetch: async (ctx, f: MonthFilter, { tx }) => {
      const b = await supplyBoard(ctx, { month: f.month ?? null, tenantId: f.tenantId ?? null }, { tx });
      return { rows: b.rows.flatMap((r) => r.balance.map((x) => ({ ...x, tenantName: r.tenant.name }))) };
    },
  });

  registerReport({
    key: "p3.late_water_orders",
    title: "Pesanan air mitra lewat SLA (PAR-76)",
    module: "p3",
    permission: "p3.partner_supply.read",
    containsPii: false,
    filtersSchema: monthFilter,
    describeFilters: describeMonth,
    columns: [
      { key: "number", header: "Pesanan", width: 14 },
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "customerName", header: "Pelanggan mitra", width: 18 },
      { key: "tankCount", header: "Tangki", type: "number", width: 8 },
      { key: "status", header: "Status", type: "enum", enumName: "order_status", width: 12 },
      { key: "createdAt", header: "Dibuat", type: "datetime", width: 16 },
      { key: "slaDueAt", header: "Batas SLA", type: "datetime", width: 16 },
    ],
    fetch: async (ctx, f: MonthFilter, { tx }) => ({ rows: (await supplyBoard(ctx, { month: f.month ?? null, tenantId: f.tenantId ?? null }, { tx })).lateOrders }),
  });

  registerReport({
    key: "p3.subscription_invoices",
    title: "Faktur & tagihan mitra (langganan sistem, air/spare part tempo)",
    module: "p3",
    permission: "p3.subscription.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "number", header: "Faktur", width: 14 },
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "customerName", header: "Pelanggan mitra", width: 18 },
      { key: "periodMonth", header: "Bulan layanan", type: "date", width: 11 },
      { key: "issueDate", header: "Terbit", type: "date", width: 11 },
      { key: "dueDate", header: "Jatuh tempo", type: "date", width: 11 },
      { key: "amount", header: "Nilai", type: "rupiah", total: true, width: 13 },
      { key: "paidAmount", header: "Dibayar", type: "rupiah", total: true, width: 13 },
      { key: "outstandingAmount", header: "Sisa", type: "rupiah", total: true, width: 13 },
      { key: "status", header: "Status", type: "enum", enumName: "invoice_status", width: 12 },
      { key: "overdueDays", header: "Lewat tempo (hari)", type: "number", width: 9 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await subscriptionBoard(ctx, {}, { tx })).invoices }),
  });

  registerReport({
    key: "p3.support_requests",
    title: "Permintaan dukungan teknis mitra (SLA tanggap PAR-76)",
    module: "p3",
    permission: "p3.support_request.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "tenantName", header: "Mitra", width: 16 },
      { key: "outletName", header: "Outlet", width: 16 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "support_request_kind", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "support_request_status", width: 11 },
      { key: "submittedAt", header: "Diajukan", type: "datetime", width: 15 },
      { key: "respondedAt", header: "Ditanggapi", type: "datetime", width: 15 },
      { key: "doneAt", header: "Selesai", type: "datetime", width: 15 },
      { key: "responseHours", header: "Waktu tanggap (jam)", type: "number", width: 10 },
      { key: "slaStatus", header: "SLA", type: "enum", enumName: "partner_sla_status", width: 11 },
      { key: "description", header: "Uraian", width: 30 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listSupportRequests(ctx, {}, { tx }) }),
  });

  // ------------------------------------------------------------------------------------------------ RL-7 (portal)
  registerReport({
    key: "p3.partner_monthly",
    title: "Laporan bulanan mitra",
    module: "p3",
    permission: "p3.partner_report.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ period: z.string().refine(isValidMonth, { error: "Periode harus YYYY-MM." }), tenantId: z.uuid().optional() }),
    describeFilters: (f: { period: string }) => [`Periode: ${f.period}`],
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "transactions", header: "Transaksi", type: "number", total: true, width: 9 },
      { key: "gallons", header: "Galon", type: "number", total: true, width: 9 },
      { key: "salesTotal", header: "Penjualan", type: "rupiah", total: true, width: 13 },
      { key: "voidCount", header: "Void", type: "number", total: true, width: 7 },
      { key: "voidAmount", header: "Nilai void", type: "rupiah", total: true, width: 12 },
      { key: "cashDifference", header: "Selisih shift", type: "rupiah", total: true, width: 12 },
    ],
    fetch: async (ctx, f: { period: string; tenantId?: string }, { tx }) => {
      const own = await loadTenant(tx, ctx.tenantId);
      let data: Awaited<ReturnType<typeof buildMonthlyReportData>> | null = null;
      if (own?.kind === "partner") {
        const report = await portalMonthlyReport(ctx, f.period, { tx });
        if (!report) throw new NotFoundError("Laporan bulanan periode ini belum terbit.");
        data = report.data as unknown as Awaited<ReturnType<typeof buildMonthlyReportData>>;
      } else {
        if (!f.tenantId) throw ValidationError.field("tenantId", "Pilih mitra.");
        data = await buildMonthlyReportData(tx, f.tenantId, f.period, ctx.now);
      }
      const bal = data.waterBalance;
      return {
        rows: data.daily,
        status: "Terbit",
        summary: [
          { label: "Mitra", value: data.tenantName },
          { label: "Program", value: data.programName },
          { label: "Total penjualan", value: data.totals.salesTotal, type: "rupiah" },
          { label: "Galon terjual", value: data.totals.gallons, type: "number" },
          { label: "Void", value: data.totals.voidCount, type: "number" },
          { label: "Pasokan air diterima (L)", value: data.totals.supplyReceivedL, type: "liter" },
          ...bal.map((b) => ({ label: `Neraca air ${b.outletName}`, value: `${b.soldL.toLocaleString("id-ID")} L terjual vs ${b.availableL.toLocaleString("id-ID")} L tersedia (kelebihan ${b.excessPct}%, toleransi ${b.tolerancePct}%)` })),
          { label: "Tagihan terbit", value: data.totals.invoiced, type: "rupiah" as const },
          { label: "Dibayar", value: data.totals.paid, type: "rupiah" as const },
          { label: "Sisa tagihan", value: data.totals.outstanding, type: "rupiah" as const },
          { label: "Permintaan dukungan", value: `${data.sla.total} (tepat waktu ${data.sla.respondedOnTime}, lewat SLA ${data.sla.late})` },
          { label: "Kepatuhan SLA dukungan", value: data.sla.compliancePct === null ? "-" : `${data.sla.compliancePct}%` },
        ],
      };
    },
  });

  registerReport({
    key: "p3.partner_sales",
    title: "Penjualan harian outlet mitra (galon, void, selisih shift)",
    module: "p3",
    permission: "p3.partner_report.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ from: z.string().refine(isBusinessDate).optional(), to: z.string().refine(isBusinessDate).optional(), outletId: z.uuid().optional() }),
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "outletName", header: "Outlet", width: 18 },
      { key: "transactions", header: "Transaksi", type: "number", total: true, width: 9 },
      { key: "gallons", header: "Galon", type: "number", total: true, width: 9 },
      { key: "salesTotal", header: "Penjualan", type: "rupiah", total: true, width: 13 },
      { key: "voidCount", header: "Void", type: "number", total: true, width: 7 },
      { key: "cashDifference", header: "Selisih shift", type: "rupiah", total: true, width: 12 },
    ],
    fetch: async (ctx, f: { from?: string; to?: string; outletId?: string }, { tx }) => ({ rows: (await portalSalesReport(ctx, { from: f.from ?? null, to: f.to ?? null, outletId: f.outletId ?? null }, { tx })).daily }),
  });

  registerReport({
    key: "p3.partner_purchases",
    title: "Riwayat pembelian air & spare part mitra per bulan",
    module: "p3",
    permission: "p3.partner_report.read",
    containsPii: false,
    filtersSchema: z.object({ tenantId: z.uuid().optional() }),
    columns: [
      { key: "month", header: "Bulan", width: 10 },
      { key: "waterTrips", header: "Rit air", type: "number", total: true, width: 9 },
      { key: "waterL", header: "Liter air", type: "liter", total: true, width: 11 },
      { key: "waterAmount", header: "Nilai air", type: "rupiah", total: true, width: 13 },
      { key: "sparePartTransactions", header: "Transaksi spare part", type: "number", total: true, width: 10 },
      { key: "sparePartAmount", header: "Nilai spare part", type: "rupiah", total: true, width: 13 },
    ],
    fetch: async (ctx, f: { tenantId?: string }, { tx }) => {
      const own = await loadTenant(tx, ctx.tenantId);
      if (own?.kind === "partner") return { rows: await portalPurchaseHistory(ctx, { tx }) };
      if (!f.tenantId) throw ValidationError.field("tenantId", "Pilih mitra.");
      return { rows: await partnerPurchaseHistory(ctx, { tenantId: f.tenantId }, { tx }) };
    },
  });

  // ------------------------------------------------------------------------------------------------ Tahap 3
  registerReport({
    key: "p3.contracts",
    title: "Kontrak mitra & parameternya",
    module: "p3",
    permission: "p3.partner_contract.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "number", header: "Kontrak", width: 12 },
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "option", header: "Opsi", type: "enum", enumName: "partner_option", width: 16 },
      { key: "status", header: "Status", type: "enum", enumName: "partner_contract_status", width: 11 },
      { key: "startDate", header: "Mulai", type: "date", width: 11 },
      { key: "endDate", header: "Berakhir", type: "date", width: 11 },
      { key: "subscriptionFeePerOutlet", header: "Langganan/outlet", type: "rupiah", width: 12, value: (r: { termsNow: { subscriptionFeePerOutlet: number } }) => r.termsNow.subscriptionFeePerOutlet },
      { key: "royalty", header: "Royalti %", type: "number", width: 8, value: (r: { termsNow: { royaltyBp: number } }) => r.termsNow.royaltyBp / 100 },
      { key: "discount", header: "Diskon air %", type: "number", width: 8, value: (r: { termsNow: { waterDiscountBp: number } }) => r.termsNow.waterDiscountBp / 100 },
      { key: "creditLimit", header: "Batas kredit", type: "rupiah", width: 12 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listContracts(ctx, {}, { tx }) }),
  });

  registerReport({
    key: "p3.prospects",
    title: "Calon mitra & hasil penilaian lokasi",
    module: "p3",
    permission: "p3.partner.read",
    containsPii: true,
    orientation: "landscape",
    columns: [
      { key: "name", header: "Calon mitra", width: 20 },
      { key: "waPhone", header: "WA", pii: "phone", width: 14 },
      { key: "proposedAddress", header: "Lokasi usulan", pii: "address", width: 26 },
      { key: "status", header: "Status", type: "enum", enumName: "prospect_status", width: 14 },
      { key: "routeDistanceM", header: "Jarak rute (m)", type: "number", width: 10 },
      { key: "radiusViolation", header: "Langgar radius", type: "boolean", width: 9 },
      { key: "capacityAvailable", header: "Kapasitas tersedia", type: "boolean", width: 9 },
      { key: "infeasibleReason", header: "Catatan penilaian", width: 30 },
    ],
    fetch: async (ctx, _f, { tx }) => {
      await assertPortalEnabled(tx);
      return { rows: await listProspects(ctx, {}, { tx }) };
    },
  });

  registerReport({
    key: "p3.sanctions",
    title: "Sanksi mitra & riwayatnya",
    module: "p3",
    permission: "p3.partner.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "contractNumber", header: "Kontrak", width: 12 },
      { key: "trigger", header: "Pemicu", type: "enum", enumName: "sanction_trigger", width: 16 },
      { key: "level", header: "Tingkat", type: "enum", enumName: "sanction_level", width: 16 },
      { key: "status", header: "Status", type: "enum", enumName: "sanction_status", width: 12 },
      { key: "createdAt", header: "Tercatat", type: "datetime", width: 15 },
      { key: "decidedAt", header: "Diputuskan", type: "datetime", width: 15 },
      { key: "decisionReason", header: "Alasan keputusan", width: 26 },
      { key: "liftReason", header: "Alasan pencabutan", width: 22 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listSanctions(ctx, {}, { tx }) }),
  });

  registerReport({
    key: "p3.quality_scores",
    title: "Skor mutu outlet mitra (daftar periksa, audit, uji air)",
    module: "p3",
    permission: "p3.partner_score.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ month }),
    columns: [
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "outletName", header: "Outlet", width: 18 },
      { key: "compliancePct", header: "Kepatuhan daftar periksa %", type: "percent", width: 10 },
      { key: "checklistScore", header: "Skor daftar periksa", type: "number", width: 10 },
      { key: "auditScore", header: "Skor audit", type: "number", width: 9 },
      { key: "testScore", header: "Skor uji air", type: "number", width: 9 },
      { key: "totalScore", header: "Skor total", type: "number", width: 9 },
      { key: "belowThreshold", header: "< PAR-80", type: "boolean", width: 8 },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => {
      const b = await qualityBoard(ctx, { month: f.month ?? null }, { tx });
      return {
        rows: b.outlets.map((o) => ({
          tenantName: o.tenantName,
          outletName: o.outletName,
          compliancePct: o.compliance.compliancePct,
          checklistScore: o.score?.checklistScore ?? o.live.checklistScore,
          auditScore: o.score?.auditScore ?? o.live.auditScore,
          testScore: o.score?.testScore ?? o.live.testScore,
          totalScore: o.score?.totalScore ?? o.live.totalScore,
          belowThreshold: o.score?.belowThreshold ?? o.live.belowThreshold,
        })),
      };
    },
  });

  registerReport({
    key: "p3.partner_dashboard",
    title: "Kinerja mitra per bulan (omzet, galon, air, neraca, tagihan, skor, sanksi)",
    module: "p3",
    permission: "p3.partner.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ month }),
    columns: [
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "salesTotal", header: "Omzet POS", type: "rupiah", total: true, width: 13 },
      { key: "gallons", header: "Galon", type: "number", total: true, width: 9 },
      { key: "waterTrips", header: "Rit air", type: "number", total: true, width: 8 },
      { key: "waterL", header: "Liter air", type: "liter", total: true, width: 10 },
      { key: "sparePartAmount", header: "Spare part", type: "rupiah", total: true, width: 12 },
      { key: "issued", header: "Tagihan terbit", type: "rupiah", total: true, width: 12 },
      { key: "paid", header: "Dibayar", type: "rupiah", total: true, width: 12 },
      { key: "overdue", header: "Lewat tempo", type: "rupiah", total: true, width: 12 },
      { key: "waterBalanceExceeded", header: "Neraca merah", type: "boolean", width: 8 },
      { key: "sanctions", header: "Sanksi berlaku", type: "number", width: 8 },
      { key: "nextEvaluationDate", header: "Evaluasi berikutnya", type: "date", width: 11 },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => ({
      rows: (await partnerDashboard(ctx, { month: f.month ?? null }, { tx })).rows.map((m) => ({
        tenantName: m.tenant.name,
        salesTotal: m.salesTotal,
        gallons: m.gallons,
        waterTrips: m.waterTrips,
        waterL: m.waterL,
        sparePartAmount: m.sparePartAmount,
        issued: m.invoices.issued,
        paid: m.invoices.paid,
        overdue: m.invoices.overdue,
        waterBalanceExceeded: m.waterBalanceExceeded,
        sanctions: m.activeSanctions.length,
        nextEvaluationDate: m.nextEvaluationDate,
      })),
    }),
  });

  registerReport({
    key: "p3.coach_portfolio",
    title: "Portofolio pembina wilayah (peringkat risiko mitra)",
    module: "p3",
    permission: "p3.partner_score.read",
    containsPii: false,
    filtersSchema: z.object({ month }),
    columns: [
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "risk", header: "Risiko", type: "enum", enumName: "partner_risk_level", width: 9 },
      { key: "riskPoints", header: "Poin risiko", type: "number", width: 8 },
      { key: "reasons", header: "Alasan", width: 36 },
      { key: "nextAudit", header: "Audit berikutnya", type: "date", width: 11 },
      { key: "openFindings", header: "Temuan terbuka", type: "number", width: 9 },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => ({
      rows: (await coachPortfolio(ctx, { month: f.month ?? null }, { tx })).rows.map((r) => ({ tenantName: r.metrics.tenant.name, risk: r.risk, riskPoints: r.riskPoints, reasons: r.reasons.join("; "), nextAudit: r.nextAudit, openFindings: r.openFindings })),
    }),
  });

  registerReport({
    key: "p3.partnership_economics",
    title: "Ekonomi kemitraan: pendapatan EQUA per mitra vs ilustrasi",
    module: "p3",
    permission: "p3.partner_economics.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ month }),
    columns: [
      { key: "tenantName", header: "Mitra", width: 18 },
      { key: "water", header: "Air", type: "rupiah", total: true, width: 12 },
      { key: "sparePart", header: "Spare part", type: "rupiah", total: true, width: 12 },
      { key: "subscription", header: "Langganan & fee", type: "rupiah", total: true, width: 12 },
      { key: "royalty", header: "Royalti", type: "rupiah", total: true, width: 12 },
      { key: "total", header: "Total", type: "rupiah", total: true, width: 13 },
      { key: "illustration", header: "Ilustrasi 9.7", type: "rupiah", total: true, width: 13 },
      { key: "gapPct", header: "Selisih %", type: "percent", width: 9 },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => {
      const e = await partnershipEconomics(ctx, { month: f.month ?? null }, { tx });
      return {
        rows: e.rows.map((r) => ({ tenantName: r.tenant.name, ...r.revenue, total: r.total, illustration: r.illustration, gapPct: r.gapPct })),
        summary: [
          { label: "Komitmen kapasitas mitra (rit/bulan)", value: e.capacity.committedTrips, type: "number" },
          { label: "Ruang kapasitas K22 (rit/bulan)", value: e.capacity.roomTrips, type: "number" },
          { label: "Rit mitra terealisasi bulan ini", value: e.capacity.actualTrips, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "p3.royalty_detail",
    title: "Rincian dasar royalti: omzet per outlet per hari",
    module: "p3",
    permission: "p3.subscription.read",
    containsPii: false,
    filtersSchema: z.object({ contractId: z.uuid(), month: z.string().refine(isValidMonth, { error: "Bulan harus YYYY-MM." }) }),
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "transactions", header: "Transaksi", type: "number", total: true, width: 9 },
      { key: "sales", header: "Omzet Sah (tanpa void)", type: "rupiah", total: true, width: 14 },
    ],
    fetch: async (ctx, f: { contractId: string; month: string }, { tx }) => {
      const calc = await royaltyDetail(ctx, { contractId: f.contractId, month: f.month }, { tx });
      const detail = ((calc?.detail as { royaltyDetail?: Record<string, unknown>[] } | null)?.royaltyDetail ?? []) as Record<string, unknown>[];
      return { rows: detail, summary: calc ? [{ label: "Royalti", value: calc.royaltyAmount, type: "rupiah" }, { label: "Omzet dasar", value: calc.grossSales, type: "rupiah" }] : [] };
    },
  });

  registerReport({
    key: "p3.partner_data_export",
    title: "Ekspor data outlet mitra (transaksi POS) — pemutusan/berakhir (PTB-58)",
    module: "p3",
    permission: "p3.partner_data_export.create",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ tenantId: z.uuid() }),
    columns: [
      { key: "businessDate", header: "Tanggal", type: "date", width: 11 },
      { key: "outletCode", header: "Outlet", width: 8 },
      { key: "number", header: "Nomor", width: 18 },
      { key: "method", header: "Cara bayar", type: "enum", enumName: "payment_method", width: 10 },
      { key: "status", header: "Status", type: "enum", enumName: "pos_sale_status", width: 11 },
      { key: "total", header: "Total", type: "rupiah", total: true, width: 12 },
    ],
    fetch: async (_ctx, f: { tenantId: string }, { tx }) => {
      const data = await partnerDataForExport(tx, f.tenantId);
      const codes = new Map(data.outlets.map((o) => [o.id, o.code]));
      return { rows: data.sales.map((s) => ({ ...s, number: s.number ?? s.localNumber, outletCode: codes.get(s.outletId) ?? "" })) };
    },
  });

}
