/**
 * M1 — Master Data: API PUBLIK modul. Pelanggan, alamat, produk & harga, zona tarif, armada, depot, sumber air, karyawan, impor data awal (PRD 7.1).
 *
 * Modul lain dan UI hanya boleh mengimpor dari berkas ini (docs/ARCHITECTURE.md §3 butir 3) atau berkomunikasi lewat
 * event domain. Fungsi layanan berbentuk `fn(ctx, input, opts?)` dengan urutan: authorize → validasi Zod → aturan
 * bisnis + pemisahan tugas → satu transaksi → audit.record → events.emit (lihat `src/server/core`).
 *
 * Kontrak untuk modul lain (rincian: docs/dev/modules/m1-master.md):
 * - M2 pesanan: `searchCustomers`, `getCustomerSummary`, `quickCreateCustomer`, `resolveTruckWaterPrice` (kunci harga),
 *   `detectTruckPriceChange` (PTB-13), `assertTruckCanReceiveTrips`, `truckDailyTripCapacity`.
 * - M6/M7 POS: `resolveProductPrice` (+ pull `m1.catalog`, `m1.store_partners`).
 * - M8/M11 transfer internal: `resolveInternalTransferPrice` (BR-33, K20).
 * - M12: `compareTripDistanceToZone` (US-M1-05 KP-6), `mapAddressToZone`.
 * - M10: event `employee.exited` (dipancarkan M1).
 */
import "server-only";

export const MODULE_KEY = "m1-master" as const;
export const MODULE_NAME = "Master Data" as const;

// --- Pelanggan & alamat (US-M1-01) -----------------------------------------------------------------------------------
export {
  addAddress,
  clearAddressManualZone,
  confirmCoordinateProposal,
  coordinateLockProgress,
  createCustomer,
  deactivateAddress,
  deactivateCustomer,
  defaultCreditTerms,
  findDuplicateCandidates,
  getCustomerDetail,
  getCustomerSummary,
  listCoordinateProposals,
  listCustomers,
  openReceivable,
  proposeCoordinateFromTrip,
  quickCreateCustomer,
  reactivateCustomer,
  refreshStorePartnerFlags,
  rejectCoordinateProposal,
  searchCustomers,
  setAddressCoordinates,
  setAddressManualZone,
  setAddressReferenceSource,
  setStorePartner,
  updateAddress,
  updateCustomer,
} from "./service/customers";
export type {
  AddressInput,
  CreateCustomerInput,
  CreateCustomerResult,
  CustomerListRow,
  CustomerSearchResult,
  CustomerSummary,
  DuplicateCandidate,
  QuickCreateCustomerInput,
  UpdateCustomerInput,
  UpdateCustomerResult,
} from "./service/customers";

// --- Status kredit (US-M1-01 KP-3/KP-4) ------------------------------------------------------------------------------
export { evaluateCreditEligibility, getCreditEligibility, requestCreditGrant, requestCreditTermsChange } from "./service/credit";
export type { CreditEligibility } from "./service/credit";

// --- Harga khusus (US-M1-01 KP-5) ------------------------------------------------------------------------------------
export { listSpecialPriceReviews, requestSpecialPrice, reviewSpecialPrice, specialPricesDueForReview } from "./service/special-prices";
export type { RequestSpecialPriceInput, SpecialPriceReviewRow } from "./service/special-prices";

// --- Produk & harga (US-M1-02) ---------------------------------------------------------------------------------------
export { createProduct, currentFuelComponent, listProducts, setProductActive, updateProduct } from "./service/products";
export type { ProductInput, ProductListRow } from "./service/products";
export {
  compareTripDistanceToZone,
  detectTruckPriceChange,
  getActiveSpecialPrice,
  getFuelComponent,
  getZoneTariff,
  priceHistory,
  proposeFuelComponent,
  proposeProductPrice,
  proposeZoneTariff,
  resolveInternalTransferPrice,
  resolveProductPrice,
  resolveTruckWaterPrice,
} from "./service/pricing";
export type { PriceHistoryRow, PriceProposalResult, ProductPriceResult, TruckWaterPrice } from "./service/pricing";

// --- Zona tarif (US-M1-05) -------------------------------------------------------------------------------------------
export { mapAddressToZone, proposeZoneTable, setRoutingProviderForTests, zoneTableAt } from "./service/zones";
export type { MovedAddress, ProposeZoneTableInput, ZoneMapping, ZoneTableEntry } from "./service/zones";
export { getZoneOverview, listZoneMoves, simulateZonePricing } from "./service/zone-views";
export type { ZoneOverview, ZoneSimulationRow } from "./service/zone-views";

// --- Armada (US-M1-03) -----------------------------------------------------------------------------------------------
export { assertTruckCanReceiveTrips, createTruck, listTrucks, setTruckStatus, truckDailyTripCapacity, truckFormOptions, updateTruck } from "./service/fleet";
export type { TruckInput, TruckListRow } from "./service/fleet";

// --- Depot, sumber air, pool, karyawan (US-M1-04) --------------------------------------------------------------------
export {
  addWaterMeter,
  createEmployee,
  createOutlet,
  createPool,
  createWaterSource,
  deactivateWaterMeter,
  employeeFormOptions,
  listEmployees,
  listOutlets,
  listPools,
  listWaterSources,
  processEmployeeExits,
  setEmployeeActive,
  setOutletActive,
  setPoolActive,
  setWaterSourceActive,
  updateEmployee,
  updateOutlet,
  updatePool,
  updateWaterSource,
} from "./service/org";
export type { EmployeeInput, OutletInput, PoolInput, WaterMeterInput, WaterSourceInput } from "./service/org";

// --- Impor data awal & tanda tangan (US-M1-06) -----------------------------------------------------------------------
export { IMPORT_DEFS, IMPORT_KINDS_M1, isImportKindM1 } from "./service/import/definitions";
export type { ImportKindM1 } from "./service/import/definitions";
export { buildImportTemplate, parseImportWorkbook } from "./service/import/workbook";
export {
  allowedImportModes,
  cancelImport,
  commitImport,
  getImportBatch,
  listImportBatches,
  resolveImportRow,
  updateImportRow,
  uploadImport,
} from "./service/import/service";
export type { ImportMode, ImportSummary } from "./service/import/service";
export { initialDataStatus, listSignoffs, M1_SIGNOFF_GROUPS, signDataSignoff } from "./service/import/signoff";
export type { InitialDataStatus } from "./service/import/signoff";
