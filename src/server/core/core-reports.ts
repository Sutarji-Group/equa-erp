/**
 * Laporan inti yang dapat diekspor:
 * - `core.rbac_matrix` — matriks peran × tindakan (US-M10-03 KP-4; pemilik).
 * - `core.audit_log`   — jejak audit dalam bahasa lapangan (US-M10-05 KP-6; pemilik).
 */
import "server-only";

import { z } from "zod";

import { businessDateToUtcRange, isBusinessDate } from "@/lib/time";

import { describeAudit, queryForActor } from "./audit";
import { registerReport } from "./export/registry";
import type { ReportColumn } from "./export/types";
import { exportMatrix, type MatrixRow } from "./rbac/matrix";
import { ALL_ROLES, ROLE_CATALOG } from "./rbac/roles";

const auditFilters = z.object({
  objectType: z.string().optional(),
  objectId: z.string().optional(),
  actorUserId: z.string().optional(),
  action: z.string().optional(),
  from: z.string().refine(isBusinessDate, { error: "Tanggal awal harus YYYY-MM-DD." }).optional(),
  to: z.string().refine(isBusinessDate, { error: "Tanggal akhir harus YYYY-MM-DD." }).optional(),
});

export function registerCoreReports(): void {
  registerReport({
    key: "core.rbac_matrix",
    title: "Matriks peran × tindakan",
    module: "m10",
    permission: "m10.role.export",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "moduleLabel", header: "Modul", width: 16 },
      { key: "label", header: "Tindakan", width: 40 },
      { key: "key", header: "Kode izin", width: 30 },
      ...ALL_ROLES.map(
        (role): ReportColumn<MatrixRow> => ({
          key: `role_${role}`,
          header: ROLE_CATALOG[role].label,
          width: 10,
          value: (row) => row.grants[role],
        }),
      ),
    ],
    fetch: async () => ({ rows: exportMatrix().rows }),
  });

  registerReport({
    key: "core.audit_log",
    title: "Jejak audit",
    module: "m10",
    permission: "m10.audit_log.export",
    containsPii: false,
    orientation: "landscape",
    filtersSchema: auditFilters,
    columns: [
      { key: "serverTime", header: "Waktu server", type: "datetime", width: 18 },
      { key: "deviceTime", header: "Waktu perangkat", type: "datetime", width: 18 },
      { key: "source", header: "Sumber", type: "enum", enumName: "actor_source", width: 14 },
      { key: "objectType", header: "Objek", width: 16 },
      { key: "objectId", header: "ID objek", width: 24 },
      { key: "action", header: "Tindakan", width: 12 },
      { key: "description", header: "Uraian", width: 60 },
      { key: "hash", header: "Hash", width: 20 },
    ],
    fetch: async (ctx, filters: z.infer<typeof auditFilters>, { tx }) => {
      const rows = await queryForActor(
        ctx,
        {
          objectType: filters.objectType,
          objectId: filters.objectId,
          actorUserId: filters.actorUserId,
          action: filters.action,
          from: filters.from ? businessDateToUtcRange(filters.from).start : undefined,
          to: filters.to ? businessDateToUtcRange(filters.to).end : undefined,
          limit: 1000,
        },
        { tx },
      );
      return { rows: rows.map((r) => ({ ...r, description: describeAudit(r) })) };
    },
  });
}
