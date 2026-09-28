/**
 * M12 — registrasi jejak audit (dipanggil `ensureBootstrapped` lewat `registerAudit()`).
 *
 * Objek: kejadian armada (`fleet_event`, juga didaftarkan M3 dengan label sama), penanda GPS ponsel cadangan
 * (`phone_tracking_flag`), status perangkat GPS (objek inti `device`). M12 tidak memiliki lampiran sendiri (bukti kirim
 * = objek `trip` milik M3; pengisian = M8) dan tidak ada objek keuangan (estimasi BBM = informasi, tidak dijurnal).
 */
import "server-only";

import { registerAuditFieldLabel, registerAuditObjectLabel } from "@/server/core/audit";

export function registerAudit(): void {
  registerAuditObjectLabel("fleet_event", "kejadian armada");
  registerAuditObjectLabel("phone_tracking_flag", "GPS ponsel cadangan");
  registerAuditObjectLabel("gps_vendor", "layanan vendor GPS");

  registerAuditFieldLabel("fleet_event", "kind", { label: "jenis kejadian", format: "enum:fleet_event_kind" });
  registerAuditFieldLabel("fleet_event", "status", { label: "status kejadian", format: "enum:fleet_event_status" });
  registerAuditFieldLabel("fleet_event", "reviewDecision", { label: "keputusan tinjauan", format: "enum:fleet_review_decision" });
  registerAuditFieldLabel("fleet_event", "requiresExplanation", { label: "keterangan sopir diminta", format: "boolean" });
  registerAuditFieldLabel("fleet_event", "startedAt", { label: "mulai", format: "datetime" });
  registerAuditFieldLabel("device", "gpsState", { label: "status GPS", format: "enum:gps_state" });
  registerAuditFieldLabel("phone_tracking_flag", "enabled", { label: "aktif", format: "boolean" });
}
