/**
 * M10 — laporan yang dapat diekspor Excel/PDF (NFR-23; setiap daftar modul yang disebut PRD). Matriks peran × tindakan
 * (`core.rbac_matrix`) dan jejak audit (`core.audit_log`) didaftarkan core.
 *
 * | Kunci                    | Isi                                                  | Izin                        |
 * |--------------------------|------------------------------------------------------|-----------------------------|
 * | m10.users                | daftar pengguna, peran, lingkup, login terakhir      | m10.user.read               |
 * | m10.access_review        | tinjauan hak akses kuartalan + penanda               | m10.access_review.read      |
 * | m10.devices              | daftar perangkat                                     | m10.device.read             |
 * | m10.device_usage         | riwayat pemakaian satu perangkat                     | m10.device.read             |
 * | m10.sync_health          | perangkat & sinkron                                  | m10.sync_health.read        |
 * | m10.access_log           | log akses                                            | m10.access_log.export       |
 * | m10.denials              | percobaan tindakan ditolak                           | m10.access_log.read         |
 * | m10.incidents            | insiden + waktu tanggap/pulih                        | m10.incident.read           |
 * | m10.support_tickets      | laporan kendala & masukan lapangan                   | m10.support_ticket.read     |
 * | m10.backup_status        | status cadangan & uji pemulihan                      | m10.backup_status.read      |
 * | m10.anonymization        | permintaan anonimisasi                               | m10.personal_data.read      |
 */
import "server-only";

import { z } from "zod";

import { enumValues, label } from "@/lib/labels";
import { isBusinessDate } from "@/lib/time";
import { registerReport } from "@/server/core/export";

import { accessReviewList } from "./service/access-review";
import { listAnonymizationRequests } from "./service/anonymization";
import { backupOverview } from "./service/backup";
import { getDeviceDetail, listDevices } from "./service/devices";
import { listAccessLogs, listDenials } from "./service/logs";
import { listIncidents } from "./service/monitoring";
import { listSupportTickets } from "./service/support";
import { listSyncHealth } from "./service/sync-health";
import { uptimeReport } from "./service/uptime";
import { listUsers } from "./service/users";

const dateFilter = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." });

export function registerReports(): void {
  registerReport({
    key: "m10.users",
    title: "Daftar pengguna & hak akses",
    module: "m10",
    permission: "m10.user.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "fullName", header: "Nama", width: 26 },
      { key: "employeeNo", header: "No. karyawan", width: 12 },
      { key: "username", header: "Nama pengguna", width: 16 },
      { key: "status", header: "Status", type: "enum", enumName: "user_status", width: 16 },
      { key: "roleText", header: "Peran", width: 30 },
      { key: "scopeText", header: "Lingkup", width: 36 },
      { key: "lastLoginAt", header: "Login terakhir", type: "datetime", width: 18 },
    ],
    fetch: async (ctx, _filters, { tx }) => {
      const rows = await listUsers(ctx, { status: "all" }, { tx });
      return {
        rows: rows.map((r) => ({
          ...r,
          roleText: r.roles.map((x) => `${label("role", x.role)}${x.status === "pending" ? " (menunggu)" : ""}${x.validUntil ? ` s.d. ${x.validUntil}` : ""}`).join(", "),
          scopeText: r.scopes.map((s) => s.label).join(", "),
        })),
      };
    },
  });

  registerReport({
    key: "m10.access_review",
    title: "Tinjauan hak akses kuartalan",
    module: "m10",
    permission: "m10.access_review.read",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: z.object({ quarter: z.string().regex(/^\d{4}-Q[1-4]$/).optional() }),
    describeFilters: (f) => (f.quarter ? [`Kuartal ${f.quarter}`] : ["Kuartal berjalan"]),
    columns: [
      { key: "fullName", header: "Nama", width: 26 },
      { key: "username", header: "Nama pengguna", width: 16 },
      { key: "roleText", header: "Peran (masa berlaku)", width: 30 },
      { key: "scopeText", header: "Lingkup", width: 34 },
      { key: "lastLoginAt", header: "Login terakhir", type: "datetime", width: 18 },
      { key: "flagText", header: "Penanda", width: 30 },
    ],
    fetch: async (ctx, f: { quarter?: string }, { tx }) => {
      const view = await accessReviewList(ctx, f.quarter, { tx });
      const flagLabel: Record<string, string> = {
        no_login: `Tanpa login > ${view.inactiveDays} hari`,
        multi_role: "Multi-peran",
        multi_role_expired: "Multi-peran lewat masa berlaku",
      };
      return {
        status: view.review?.status === "reviewed" ? "Ditinjau" : "Belum ditinjau",
        summary: [
          { label: "Kuartal", value: view.quarter },
          { label: "Pengguna", value: view.items.length, type: "number" },
          { label: "Ditandai", value: view.flaggedCount, type: "number" },
        ],
        rows: view.items.map((i) => ({
          ...i,
          roleText: i.roles.map((r) => `${r.label}${r.validUntil ? ` s.d. ${r.validUntil}` : ""}`).join(", "),
          scopeText: i.scopes.join(", "),
          flagText: i.flags.map((x) => flagLabel[x]).join(", "),
        })),
      };
    },
  });

  registerReport({
    key: "m10.devices",
    title: "Daftar perangkat terdaftar",
    module: "m10",
    permission: "m10.device.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "deviceCode", header: "Kode", width: 12 },
      { key: "name", header: "Nama", width: 24 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "device_kind", width: 12 },
      { key: "status", header: "Status", type: "enum", enumName: "device_status", width: 16 },
      { key: "unitLabel", header: "Unit", width: 24 },
      { key: "holderName", header: "Pemegang", width: 22 },
      { key: "isSpare", header: "Cadangan", type: "boolean", width: 10 },
      { key: "lastSyncAt", header: "Sinkron terakhir", type: "datetime", width: 18 },
      { key: "appVersion", header: "Versi", width: 10 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listDevices(ctx, {}, { tx }) }),
  });

  registerReport({
    key: "m10.device_usage",
    title: "Riwayat pemakaian perangkat",
    module: "m10",
    permission: "m10.device.read",
    containsPii: false,
    filtersSchema: z.object({ deviceId: z.uuid({ error: "Pilih perangkat." }) }),
    columns: [
      { key: "occurredAt", header: "Waktu", type: "datetime", width: 18 },
      { key: "event", header: "Kejadian", width: 16 },
      { key: "userName", header: "Pengguna", width: 24 },
      { key: "appVersion", header: "Versi", width: 10 },
      { key: "queueCount", header: "Antrean", type: "number", width: 10 },
      { key: "batteryPct", header: "Baterai %", type: "number", width: 10 },
    ],
    fetch: async (ctx, f: { deviceId: string }, { tx }) => {
      const d = await getDeviceDetail(ctx, f.deviceId, { tx });
      return { rows: d.usage, summary: [{ label: "Perangkat", value: `${d.device.deviceCode} — ${d.device.name}` }] };
    },
  });

  registerReport({
    key: "m10.sync_health",
    title: "Perangkat & sinkron",
    module: "m10",
    permission: "m10.sync_health.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "deviceCode", header: "Kode", width: 12 },
      { key: "unitLabel", header: "Unit", width: 24 },
      { key: "lastUserName", header: "Pengguna terakhir", width: 22 },
      { key: "lastSyncAt", header: "Sinkron terakhir", type: "datetime", width: 18 },
      { key: "reportedQueueCount", header: "Belum terkirim", type: "number", width: 12, total: true },
      { key: "appVersion", header: "Versi", width: 10 },
      { key: "belowMinVersion", header: "Perlu pembaruan", type: "boolean", width: 12 },
      { key: "batteryPct", header: "Baterai %", type: "number", width: 10 },
    ],
    fetch: async (ctx, _f, { tx }) => {
      const view = await listSyncHealth(ctx, { tx });
      return { rows: view.items, summary: [{ label: "Versi minimal", value: view.minVersion }] };
    },
  });

  const accessFilters = z.object({
    event: z.enum(enumValues("access_event")).optional(),
    username: z.string().optional(),
    from: dateFilter.optional(),
    to: dateFilter.optional(),
  });
  registerReport({
    key: "m10.access_log",
    title: "Log akses",
    module: "m10",
    permission: "m10.access_log.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: accessFilters,
    columns: [
      { key: "occurredAt", header: "Waktu", type: "datetime", width: 18 },
      { key: "eventLabel", header: "Kejadian", width: 22 },
      { key: "success", header: "Berhasil", type: "boolean", width: 10 },
      { key: "userName", header: "Pengguna", width: 22 },
      { key: "usernameAttempted", header: "Nama dicoba", width: 16 },
      { key: "rule", header: "Aturan", width: 10 },
      { key: "reason", header: "Keterangan", width: 50 },
    ],
    fetch: async (ctx, f: z.infer<typeof accessFilters>, { tx }) => ({ rows: await listAccessLogs(ctx, { ...f, limit: 1000 }, { tx }) }),
  });

  registerReport({
    key: "m10.denials",
    title: "Percobaan tindakan ditolak (30 hari)",
    module: "m10",
    permission: "m10.access_log.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "occurredAt", header: "Waktu", type: "datetime", width: 18 },
      { key: "userName", header: "Pengguna", width: 22 },
      { key: "permission", header: "Izin", width: 26 },
      { key: "rule", header: "Aturan", width: 10 },
      { key: "reason", header: "Pesan", width: 60 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await listDenials(ctx, { tx })).items }),
  });

  registerReport({
    key: "m10.incidents",
    title: "Insiden & waktu tanggap/pulih",
    module: "m10",
    permission: "m10.incident.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "detectedAt", header: "Terdeteksi", type: "datetime", width: 18 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "incident_kind", width: 20 },
      { key: "severity", header: "Tingkat", type: "enum", enumName: "incident_severity", width: 10 },
      { key: "status", header: "Status", type: "enum", enumName: "incident_status", width: 12 },
      { key: "title", header: "Judul", width: 40 },
      { key: "responseMinutes", header: "Tanggap (menit)", type: "number", width: 12 },
      { key: "recoveryMinutes", header: "Pulih (menit)", type: "number", width: 12 },
      { key: "responseBreached", header: "Tanggap lewat target", type: "boolean", width: 12 },
      { key: "recoveryBreached", header: "Pulih lewat target", type: "boolean", width: 12 },
    ],
    fetch: async (ctx, _f, { tx }) => {
      const r = await listIncidents(ctx, { limit: 500 }, { tx });
      return {
        rows: r.items,
        summary: [
          { label: "Target tanggap (menit)", value: r.targets.response_minutes, type: "number" },
          { label: "Target pulih (jam)", value: r.targets.recovery_hours, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m10.uptime_monthly",
    title: "Laporan uptime bulanan (jam layanan)",
    module: "m10",
    permission: "m10.incident.read",
    containsPii: false,
    filtersSchema: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }),
    describeFilters: (f: { month?: string }) => [`Bulan: ${f.month ?? "berjalan"}`],
    columns: [
      { key: "label", header: "Layanan", width: 30 },
      { key: "outages", header: "Gangguan", type: "number", width: 10 },
      { key: "serviceMinutes", header: "Menit jam layanan", type: "number", width: 14 },
      { key: "downtimeMinutes", header: "Menit gangguan (jam layanan)", type: "number", width: 16 },
      { key: "maintenanceMinutes", header: "Menit di jendela pemeliharaan", type: "number", width: 16 },
      { key: "availabilityPct", header: "Ketersediaan (%)", type: "number", width: 14 },
      { key: "targetPct", header: "Target (%)", type: "number", width: 10 },
      { key: "meetsTarget", header: "Memenuhi target", type: "boolean", width: 12 },
    ],
    fetch: async (ctx, f: { month?: string }, { tx }) => {
      const r = await uptimeReport(ctx, { month: f.month ?? null }, { tx });
      return { rows: r.rows, summary: [{ label: "Bulan", value: r.month }] };
    },
  });

  registerReport({
    key: "m10.support_tickets",
    title: "Laporan kendala & masukan lapangan",
    module: "m10",
    permission: "m10.support_ticket.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "createdAt", header: "Dikirim", type: "datetime", width: 18 },
      { key: "reporterName", header: "Pelapor", width: 22 },
      { key: "category", header: "Jenis", type: "enum", enumName: "ticket_category", width: 16 },
      { key: "subject", header: "Judul", width: 34 },
      { key: "status", header: "Status", type: "enum", enumName: "ticket_status", width: 12 },
      { key: "dueAt", header: "Tenggat jawaban", type: "datetime", width: 18 },
      { key: "answeredAt", header: "Dijawab", type: "datetime", width: 18 },
      { key: "overdue", header: "Lewat tenggat", type: "boolean", width: 10 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listSupportTickets(ctx, {}, { tx }) }),
  });

  registerReport({
    key: "m10.backup_status",
    title: "Status cadangan & uji pemulihan",
    module: "m10",
    permission: "m10.backup_status.read",
    containsPii: false,
    columns: [
      { key: "startedAt", header: "Mulai", type: "datetime", width: 18 },
      { key: "kind", header: "Jenis", type: "enum", enumName: "backup_kind", width: 14 },
      { key: "status", header: "Hasil", type: "enum", enumName: "backup_status", width: 10 },
      { key: "rpoMinutes", header: "RPO (menit)", type: "number", width: 10 },
      { key: "rtoMinutes", header: "RTO (menit)", type: "number", width: 10 },
      { key: "recordedByName", header: "Dicatat oleh", width: 20 },
      { key: "notes", header: "Catatan", width: 40 },
    ],
    fetch: async (ctx, _f, { tx }) => {
      const o = await backupOverview(ctx, { tx });
      return {
        rows: o.history,
        summary: [
          { label: "Uji pemulihan 12 bulan", value: o.restoreTestsLast12Months, type: "number" },
          { label: "Target per tahun", value: o.policy.restore_tests_per_year, type: "number" },
        ],
      };
    },
  });

  registerReport({
    key: "m10.anonymization",
    title: "Permintaan anonimisasi data pribadi",
    module: "m10",
    permission: "m10.personal_data.read",
    containsPii: false,
    columns: [
      { key: "createdAt", header: "Diajukan", type: "datetime", width: 18 },
      { key: "subjectType", header: "Subjek", type: "enum", enumName: "anonymization_subject", width: 14 },
      { key: "subjectName", header: "Nama (saat ini)", width: 26 },
      { key: "status", header: "Status", type: "enum", enumName: "anonymization_status", width: 20 },
      { key: "requestedByName", header: "Pemohon", width: 20 },
      { key: "executedAt", header: "Dijalankan", type: "datetime", width: 18 },
      { key: "blockedReason", header: "Keterangan", width: 40 },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listAnonymizationRequests(ctx, { tx }) }),
  });
}
