/**
 * Sinkron lapangan — API publik (docs/ARCHITECTURE.md §7). Modul mendaftarkan handler di
 * `src/server/modules/<modul>/sync.ts` → `registerSync()`:
 *
 * ```ts
 * import { registerSyncHandler, registerPullProvider } from "@/server/core/sync";
 * ```
 * Route: `POST /api/sync/push`, `POST /api/sync/upload`, `GET /api/sync/pull`, `POST /api/sync/health`.
 */
import "server-only";

export * from "./registry";
export { processPush, MAX_PUSH_BATCH, computeClockSkewMs, type PushResult, type PushResponse, type PushResultStatus } from "./push";
export { processPull, compareVersions, offlineParams, minSupportedVersion, type PullResponse, type OfflineParams } from "./pull";
export { processUpload, MAX_FIELD_UPLOAD_BYTES, FIELD_UPLOAD_TYPES, type UploadResult } from "./upload";
export { recordHealth, healthReportSchema, type HealthReport } from "./health";
export { registerCoreSync } from "./core-sync";
