/**
 * Jejak audit (FR-M10-02, NFR-11, US-M10-05; PRD 6.7).
 *
 * - `record(tx, { ctx, objectType, objectId, action, before, after, reason, rule })` — append-only; setiap baris
 *   memuat pelaku (pengguna, peran, perangkat), waktu server & perangkat, nilai lama/baru, alasan, sumber, dan aturan
 *   pemicu untuk tindakan sistem (KP-5). Integritas: **rantai hash** `hash = sha256(prev_hash + "\n" + JSON kanonik)`;
 *   penulisan diserialkan `pg_advisory_xact_lock` sehingga urutan `seq` = urutan rantai. Trigger DB menolak UPDATE /
 *   DELETE (`src/db/sql/hardening.sql`).
 *   PENULISAN DITUNDA ke akhir transaksi terkelola (`onBeforeCommit`): baris ditampung per transaksi lalu ditulis
 *   berantai tepat sebelum COMMIT, sehingga kunci rantai diambil TERAKHIR & singkat — tidak menyerialkan seluruh
 *   transaksi tulis dan tidak berlawanan urutan dengan kunci baris lain (mis. `document_sequences` dari `nextNumber`,
 *   penyebab deadlock 40P01 di Postgres multi-koneksi). Objek yang dikembalikan `record` terisi `seq`/`prevHash`/`hash`
 *   setelah transaksi selesai. Di luar transaksi terkelola (db langsung / `db.transaction` modul) ditulis seketika.
 * - `verifyAuditChain(db, { anchors })` — hitung ulang rantai; melaporkan baris pertama yang rusak (KP-2 "integritas
 *   dapat diverifikasi") dan mencocokkan titik jangkar (seq, hash) yang diterbitkan ke LUAR DB
 *   (`publishAuditCheckpoint`, job harian e-mail pemilik) — pemilik DB yang menghitung ulang seluruh rantai tetap
 *   ketahuan bila hash kepala lama tidak lagi cocok.
 * - `describeAudit(row)` — kalimat bahasa lapangan: "harga rit diubah dari Rp 200.000 menjadi Rp 210.000 oleh
 *   Pemilik, alasan: …" (KP-3).
 * - `query(tx, filter)` / `queryForActor(ctx, filter)` — pencarian per objek, pengguna, rentang waktu, jenis tindakan.
 */
import "server-only";

import { createHash, createHmac, hkdfSync } from "node:crypto";

import { and, asc, desc, eq, gt, gte, inArray, lt, sql, type SQL } from "drizzle-orm";

import { auditLogs, customerAccounts, customerAddresses, customers, orders, trips, waMessageLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { label, type RoleCode } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { serverEnv } from "@/lib/env";
import { formatTanggal, formatTanggalJam, isBusinessDate, toBusinessDate } from "@/lib/time";

import { ensureBootstrapped } from "./bootstrap";
import { ctxBusinessDate, type ActorContext } from "./context";
import { getDb, isTransaction, onBeforeCommit, txQueue, withTx, type Tx } from "./db";
import { sendEmail } from "./notifications/channels/email";
import { get as getParam } from "./params-read";
import { authorize } from "./rbac/authorize";

/** Kunci advisory lock tetap untuk menyerialkan rantai audit (konstanta 64-bit, dibagi semua proses). */
const AUDIT_CHAIN_LOCK_SQL = sql.raw("select pg_advisory_xact_lock(7264190031775104)");

export type AuditAction =
  | "create"
  | "update"
  | "submit"
  | "approve"
  | "reject"
  | "cancel"
  | "expire"
  | "reverse"
  | "deactivate"
  | "activate"
  | "void"
  | "close"
  | "lock"
  | "reopen"
  | "post"
  | "set"
  | "sign"
  | "revoke"
  | "export"
  | (string & {});

export type AuditInput = {
  ctx: ActorContext;
  objectType: string;
  objectId: string;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Aturan pemicu tindakan otomatis (mis. "BR-03"). */
  rule?: string | null;
  businessDate?: string | null;
};

export type AuditRow = typeof auditLogs.$inferSelect;

/** Normalisasi nilai untuk jsonb (Date → ISO, undefined dibuang). */
function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "null");
}

/** JSON kanonik: kunci objek diurutkan rekursif; tanpa spasi. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

type HashableRow = Pick<
  AuditRow,
  | "id"
  | "tenantId"
  | "serverTime"
  | "deviceTime"
  | "actorUserId"
  | "actorEmployeeId"
  | "actorRoles"
  | "actorDeviceId"
  | "source"
  | "objectType"
  | "objectId"
  | "action"
  | "before"
  | "after"
  | "reason"
  | "rule"
  | "businessDate"
>;

/** Isi kanonik baris yang di-hash (urutan kunci tidak berpengaruh). */
export function auditHashPayload(row: HashableRow): string {
  return canonicalJson({
    id: row.id,
    tenantId: row.tenantId ?? null,
    serverTime: row.serverTime instanceof Date ? row.serverTime.toISOString() : row.serverTime,
    deviceTime: row.deviceTime instanceof Date ? row.deviceTime.toISOString() : (row.deviceTime ?? null),
    actorUserId: row.actorUserId ?? null,
    actorEmployeeId: row.actorEmployeeId ?? null,
    actorRoles: row.actorRoles ?? null,
    actorDeviceId: row.actorDeviceId ?? null,
    source: row.source,
    objectType: row.objectType,
    objectId: row.objectId,
    action: row.action,
    before: row.before ?? null,
    after: row.after ?? null,
    reason: row.reason ?? null,
    rule: row.rule ?? null,
    businessDate: row.businessDate ?? null,
  });
}

/** `sha256(prev || "GENESIS" + "\n" + payload)` dalam hex. */
export function computeAuditHash(prevHash: string | null, payload: string): string {
  return createHash("sha256").update(`${prevHash ?? "GENESIS"}\n${payload}`).digest("hex");
}

/** Kunci antrean audit tertunda per transaksi terkelola. */
const AUDIT_QUEUE = Symbol("equa.audit.pending");

type PendingAudit = { row: HashableRow; target: AuditRow };

function buildRow(input: AuditInput): HashableRow {
  const { ctx } = input;
  const businessDate = input.businessDate ?? ctxBusinessDate(ctx);
  return {
    id: newId(),
    tenantId: ctx.tenantId ?? null,
    serverTime: new Date(),
    deviceTime: ctx.deviceTime ?? null,
    actorUserId: ctx.userId,
    actorEmployeeId: ctx.employeeId,
    actorRoles: ctx.roles.length ? [...ctx.roles] : null,
    actorDeviceId: ctx.deviceId,
    source: ctx.source,
    objectType: input.objectType,
    objectId: String(input.objectId),
    action: input.action,
    before: input.before === undefined ? null : toJsonValue(input.before),
    after: input.after === undefined ? null : toJsonValue(input.after),
    reason: input.reason ?? null,
    rule: input.rule ?? null,
    businessDate: isBusinessDate(businessDate) ? businessDate : null,
  };
}

/** Tulis baris berantai (ambil kunci rantai → baca hash terakhir → sisipkan berurutan). */
async function writeChained(tx: Tx, items: PendingAudit[]): Promise<void> {
  if (items.length === 0) return;
  await tx.execute(AUDIT_CHAIN_LOCK_SQL);
  const last = await tx.select({ hash: auditLogs.hash }).from(auditLogs).orderBy(desc(auditLogs.seq)).limit(1);
  let prevHash = last[0]?.hash ?? null;
  for (const item of items) {
    const hash = computeAuditHash(prevHash, auditHashPayload(item.row));
    const [inserted] = await tx
      .insert(auditLogs)
      .values({ ...item.row, prevHash, hash })
      .returning();
    Object.assign(item.target, inserted);
    prevHash = hash;
  }
}

/**
 * Catat satu entri jejak audit di transaksi pemanggil. Di transaksi terkelola baris ditulis tepat sebelum COMMIT
 * (lihat keterangan berkas); objek yang dikembalikan terisi lengkap (`seq`, `prevHash`, `hash`) setelah itu.
 */
export async function record(tx: Tx, input: AuditInput): Promise<AuditRow> {
  const row = buildRow(input);
  const target = { ...row, seq: 0, prevHash: null, hash: "", actorCustomerAccountId: null } as unknown as AuditRow;
  const queue = txQueue<PendingAudit>(tx, AUDIT_QUEUE);
  if (queue) {
    if (queue.length === 0) {
      onBeforeCommit(tx, async (root) => {
        const pending = txQueue<PendingAudit>(root, AUDIT_QUEUE) ?? [];
        const items = pending.splice(0, pending.length);
        await writeChained(root, items);
      });
    }
    queue.push({ row, target });
    return target;
  }
  // Transaksi tidak terkelola: tulis seketika (tanpa transaksi → buka transaksi agar kunci rantai berlaku).
  if (isTransaction(tx)) await writeChained(tx, [{ row, target }]);
  else await withTx((t) => writeChained(t, [{ row, target }]));
  return target;
}

export type AuditChainResult = {
  ok: boolean;
  checked: number;
  /** `seq` baris pertama yang tidak cocok. */
  brokenAtSeq?: number;
  reason?: string;
};

/** Titik jangkar rantai yang diterbitkan ke luar DB (e-mail pemilik / arsip WORM). */
export type AuditAnchor = { seq: number; hash: string };

/**
 * Verifikasi integritas seluruh rantai (urut `seq`, per batch). `anchors` = titik jangkar yang pernah diterbitkan ke
 * luar DB (`publishAuditCheckpoint`): hash baris `seq` itu harus tetap sama dan barisnya masih ada — penulisan ulang
 * rantai oleh pemegang akses DB (trigger dimatikan lalu seluruh hash dihitung ulang) atau pemotongan ekor ketahuan.
 */
export async function verifyAuditChain(db: Tx = getDb(), options: { batchSize?: number; anchors?: readonly AuditAnchor[] } = {}): Promise<AuditChainResult> {
  const batchSize = options.batchSize ?? 1000;
  const anchors = new Map((options.anchors ?? []).map((a) => [a.seq, a.hash]));
  let prevHash: string | null = null;
  let lastSeq = 0;
  let checked = 0;
  for (;;) {
    const rows: AuditRow[] = await db
      .select()
      .from(auditLogs)
      .where(gt(auditLogs.seq, lastSeq))
      .orderBy(asc(auditLogs.seq))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if ((row.prevHash ?? null) !== prevHash) {
        return { ok: false, checked, brokenAtSeq: row.seq, reason: "Rantai terputus: prev_hash tidak sama dengan hash baris sebelumnya." };
      }
      const expected = computeAuditHash(prevHash, auditHashPayload(row));
      if (expected !== row.hash) {
        return { ok: false, checked, brokenAtSeq: row.seq, reason: "Isi baris tidak cocok dengan hash-nya (data diubah)." };
      }
      const anchored = anchors.get(row.seq);
      if (anchored !== undefined && anchored !== row.hash) {
        return { ok: false, checked, brokenAtSeq: row.seq, reason: "Hash tidak cocok dengan titik jangkar yang diterbitkan (rantai ditulis ulang)." };
      }
      prevHash = row.hash;
      lastSeq = row.seq;
      checked++;
    }
  }
  const missing = [...anchors.keys()].filter((seq) => seq > lastSeq).sort((a, b) => a - b)[0];
  if (missing !== undefined) {
    return { ok: false, checked, brokenAtSeq: missing, reason: "Baris yang pernah dijangkarkan hilang (ekor jejak audit dipotong)." };
  }
  return { ok: true, checked };
}

/** Kepala rantai saat ini (null bila kosong). */
export async function auditChainHead(db: Tx = getDb()): Promise<AuditAnchor | null> {
  const rows = await db.select({ seq: auditLogs.seq, hash: auditLogs.hash }).from(auditLogs).orderBy(desc(auditLogs.seq)).limit(1);
  return rows[0] ?? null;
}

/**
 * Tag HMAC titik jangkar dengan kunci dari ENV (`SESSION_SECRET` → HKDF "audit-anchor"), bukan dari DB: penerima
 * e-mail dapat memastikan titik jangkar diterbitkan server, dan pemegang DB saja tidak dapat memalsukannya.
 */
export function auditAnchorTag(anchor: AuditAnchor): string {
  const key = hkdfSync("sha256", serverEnv().SESSION_SECRET, "equa-erp", "equa:audit-anchor:v1", 32);
  return createHmac("sha256", Buffer.from(key)).update(`${anchor.seq}:${anchor.hash}`).digest("hex");
}

export type AuditCheckpoint = AuditAnchor & { tag: string; at: string; recipients: string[] };

/**
 * Terbitkan titik jangkar (seq, hash kepala, tag HMAC) ke LUAR DB — e-mail ke penerima ringkasan pemilik
 * (`notifications.digest_recipients`). Dijalankan job harian `core.audit.checkpoint`. Simpan e-mail ini sebagai arsip;
 * saat verifikasi, berikan titik-titik jangkar ke `verifyAuditChain(db, { anchors })`.
 */
export async function publishAuditCheckpoint(now: Date = new Date(), db: Tx = getDb()): Promise<AuditCheckpoint | null> {
  const head = await auditChainHead(db);
  if (!head) return null;
  const { emails } = await getParam(db, "notifications.digest_recipients", toBusinessDate(now));
  const tag = auditAnchorTag(head);
  const checkpoint: AuditCheckpoint = { ...head, tag, at: now.toISOString(), recipients: [...emails] };
  if (emails.length) {
    await sendEmail({
      to: [...emails],
      subject: `EQUA — titik jangkar jejak audit ${formatTanggal(toBusinessDate(now), { weekday: false })}`,
      text: [
        "Simpan e-mail ini. Isinya dipakai untuk membuktikan jejak audit tidak diubah (US-M10-05 KP-2, NFR-11).",
        "",
        `Urutan (seq): ${head.seq}`,
        `Hash kepala: ${head.hash}`,
        `Tag server: ${tag}`,
        `Waktu: ${formatTanggalJam(now)}`,
      ].join("\n"),
    });
  }
  return checkpoint;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kalimat bahasa lapangan (US-M10-05 KP-3)
// ---------------------------------------------------------------------------------------------------------------------

export type AuditFieldFormat = "rupiah" | "liter" | "date" | "datetime" | "text" | "boolean" | "percent" | `enum:${string}`;

type FieldLabel = { label: string; format?: AuditFieldFormat };

const OBJECT_LABELS = new Map<string, string>([
  ["order", "pesanan"],
  ["trip", "rit"],
  ["customer", "pelanggan"],
  ["customer_address", "alamat kirim"],
  ["product", "produk"],
  ["product_price", "harga produk"],
  ["zone_tariff", "tarif zona"],
  ["fuel_component", "komponen BBM"],
  ["special_price", "harga khusus"],
  ["truck", "truk"],
  ["outlet", "outlet"],
  ["water_source", "sumber air"],
  ["employee", "karyawan"],
  ["user", "pengguna"],
  ["user_role", "peran pengguna"],
  ["user_scope", "lingkup pengguna"],
  ["device", "perangkat"],
  ["deposit", "setoran"],
  ["discrepancy", "selisih"],
  ["incoming_transfer", "transfer masuk"],
  ["cash_day", "hari kas"],
  ["invoice", "faktur"],
  ["customer_payment", "pelunasan"],
  ["credit_note", "nota kredit"],
  ["shift", "shift"],
  ["pos_sale", "transaksi POS"],
  ["stock_count", "opname"],
  ["purchase_receipt", "nota pembelian"],
  ["journal", "jurnal"],
  ["accounting_period", "periode"],
  ["fixed_asset", "aset tetap"],
  ["approval_request", "permintaan persetujuan"],
  ["parameter", "parameter"],
  ["feature_flag", "feature flag"],
  ["meter_reading", "pembacaan meter"],
  ["truck_fill", "pengisian truk"],
  ["fleet_event", "kejadian armada"],
]);

const FIELD_LABELS = new Map<string, FieldLabel>([
  ["*.price", { label: "harga", format: "rupiah" }],
  ["*.pricePerTrip", { label: "harga", format: "rupiah" }],
  ["*.amount", { label: "jumlah", format: "rupiah" }],
  ["*.total", { label: "total", format: "rupiah" }],
  ["*.creditLimit", { label: "batas kredit", format: "rupiah" }],
  ["*.status", { label: "status" }],
  ["*.creditStatus", { label: "status kredit", format: "enum:credit_status" }],
  ["*.volumeL", { label: "volume", format: "liter" }],
  ["*.effectiveFrom", { label: "tanggal berlaku", format: "date" }],
  ["*.name", { label: "nama" }],
  ["*.enabled", { label: "status aktif", format: "boolean" }],
  ["*.value", { label: "nilai" }],
  ["*.reason", { label: "alasan" }],
]);

/** Daftarkan label objek (append; modul memanggil saat registrasi). */
export function registerAuditObjectLabel(objectType: string, text: string): void {
  OBJECT_LABELS.set(objectType, text);
}

/** Label Bahasa Indonesia jenis objek (huruf kecil, mis. "setoran"); `null` bila belum terdaftar. Tambahan S5B. */
export function auditObjectLabel(objectType: string): string | null {
  return OBJECT_LABELS.get(objectType) ?? null;
}

/** Daftarkan label & format kolom (`objectType` atau `*` untuk semua objek). */
export function registerAuditFieldLabel(objectType: string, field: string, def: FieldLabel): void {
  FIELD_LABELS.set(`${objectType}.${field}`, def);
}

function fieldLabel(objectType: string, field: string): FieldLabel {
  return FIELD_LABELS.get(`${objectType}.${field}`) ?? FIELD_LABELS.get(`*.${field}`) ?? { label: field };
}

function formatValue(value: unknown, format?: AuditFieldFormat): string {
  if (value === null || value === undefined || value === "") return "kosong";
  if (format === "rupiah" && typeof value === "number") return formatRupiah(value);
  if (format === "liter" && typeof value === "number") return `${value.toLocaleString("id-ID")} L`;
  if (format === "date" && typeof value === "string" && isBusinessDate(value)) return formatTanggal(value, { weekday: false });
  if (format === "datetime" && (typeof value === "string" || value instanceof Date)) return formatTanggalJam(value);
  if (format === "boolean") return value ? "aktif" : "nonaktif";
  if (format === "percent" && typeof value === "number") return `${value.toLocaleString("id-ID")}%`;
  if (format?.startsWith("enum:") && typeof value === "string") {
    return label(format.slice(5) as Parameters<typeof label>[0], value);
  }
  if (typeof value === "object") return canonicalJson(value);
  return String(value);
}

const ACTION_VERBS: Record<string, string> = {
  create: "dibuat",
  update: "diubah",
  submit: "diajukan",
  approve: "disetujui",
  reject: "ditolak",
  cancel: "dibatalkan",
  expire: "lewat tenggat",
  reverse: "dibalik",
  deactivate: "dinonaktifkan",
  activate: "diaktifkan",
  void: "di-void",
  close: "ditutup",
  lock: "dikunci",
  reopen: "dibuka kembali",
  post: "diposting",
  set: "ditetapkan",
  sign: "ditandatangani",
  revoke: "dicabut",
  export: "diekspor",
};

function actorText(row: Pick<AuditRow, "source" | "actorRoles" | "rule">, actorName?: string | null): string {
  if (row.source === "system") return row.rule ? `Sistem (aturan ${row.rule})` : "Sistem";
  const roles = (row.actorRoles ?? []) as RoleCode[];
  const roleText = roles.length ? roles.map((r) => label("role", r)).join("/") : "pengguna";
  return actorName ? `${actorName} (${roleText})` : roleText;
}

function changedFields(before: unknown, after: unknown): { field: string; from: unknown; to: unknown }[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  return keys
    .filter((k) => canonicalJson(b[k] ?? null) !== canonicalJson(a[k] ?? null))
    .map((field) => ({ field, from: b[field], to: a[field] }));
}

/**
 * Kalimat Indonesia untuk satu entri audit, mis.
 * `"harga rit diubah dari Rp 200.000 menjadi Rp 210.000 oleh Pemilik, alasan: kenaikan BBM"`.
 */
export function describeAudit(
  row: Pick<AuditRow, "objectType" | "objectId" | "action" | "before" | "after" | "reason" | "rule" | "source" | "actorRoles">,
  options: { actorName?: string | null; objectLabel?: string } = {},
): string {
  ensureBootstrapped(); // label objek & kolom modul didaftarkan saat registrasi
  const objectText = options.objectLabel ?? OBJECT_LABELS.get(row.objectType) ?? row.objectType;
  const actor = actorText(row, options.actorName);
  const reason = row.reason ? `, alasan: ${row.reason}` : "";
  const verb = ACTION_VERBS[row.action] ?? row.action;

  const changes = row.action === "update" || row.action === "set" ? changedFields(row.before, row.after) : [];
  if (changes.length > 0) {
    const parts = changes.map(({ field, from, to }) => {
      const def = fieldLabel(row.objectType, field);
      const fieldText = field === "value" && row.objectType === "parameter" ? `nilai ${objectText} ${row.objectId}` : `${def.label} ${objectText}`;
      return `${fieldText} ${row.action === "set" ? "ditetapkan" : "diubah"} dari ${formatValue(from, def.format)} menjadi ${formatValue(to, def.format)}`;
    });
    return `${parts.join("; ")} oleh ${actor}${reason}`;
  }
  return `${capitalize(objectText)} ${row.objectId} ${verb} oleh ${actor}${reason}`;
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pencarian (US-M10-05 KP-3)
// ---------------------------------------------------------------------------------------------------------------------

export type AuditQuery = {
  tenantId?: string;
  objectType?: string | string[];
  objectId?: string;
  actorUserId?: string;
  action?: string | string[];
  from?: Date;
  to?: Date;
  /** Kursor: ambil baris dengan seq < nilai ini (halaman berikutnya). */
  beforeSeq?: number;
  limit?: number;
};

/** Cari jejak audit (terbaru dulu). */
export async function query(tx: Tx, filter: AuditQuery = {}): Promise<AuditRow[]> {
  const where: SQL[] = [];
  if (filter.tenantId) where.push(eq(auditLogs.tenantId, filter.tenantId));
  if (filter.objectType) {
    where.push(Array.isArray(filter.objectType) ? inArray(auditLogs.objectType, filter.objectType) : eq(auditLogs.objectType, filter.objectType));
  }
  if (filter.objectId) where.push(eq(auditLogs.objectId, filter.objectId));
  if (filter.actorUserId) where.push(eq(auditLogs.actorUserId, filter.actorUserId));
  if (filter.action) where.push(Array.isArray(filter.action) ? inArray(auditLogs.action, filter.action) : eq(auditLogs.action, filter.action));
  if (filter.from) where.push(gte(auditLogs.serverTime, filter.from));
  if (filter.to) where.push(lt(auditLogs.serverTime, filter.to));
  if (filter.beforeSeq) where.push(lt(auditLogs.seq, filter.beforeSeq));
  return tx
    .select()
    .from(auditLogs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLogs.seq))
    .limit(Math.min(filter.limit ?? 100, 1000));
}

/** Jenis objek keuangan (akuntan melihat jejaknya; admin sistem melihatnya tanpa nilai). Append-only. */
export const FINANCIAL_OBJECT_TYPES = new Set<string>([
  "deposit",
  "discrepancy",
  "incoming_transfer",
  "bank_deposit",
  "office_cash_movement",
  "petty_cash_transaction",
  "cash_day",
  "restitution",
  "invoice",
  "customer_payment",
  "customer_advance",
  "credit_note",
  "trip_payment",
  "trip_expense",
  "pos_sale",
  "shift",
  "purchase_receipt",
  "supplier_payment",
  "journal",
  "accounting_period",
  "fixed_asset",
  "account",
  "event_account_mapping",
  "opening_balance_batch",
]);

export function registerFinancialObjectType(objectType: string): void {
  FINANCIAL_OBJECT_TYPES.add(objectType);
}

/**
 * Pencarian dengan aturan peran (US-M10-05 KP-6, US-M10-06 KP-1): pemilik melihat semua; akuntan hanya objek
 * keuangan; admin sistem melihat semua tetapi nilai lama/baru objek keuangan disembunyikan.
 */
export async function queryForActor(ctx: ActorContext, filter: AuditQuery = {}, opts: { tx?: Tx } = {}): Promise<AuditRow[]> {
  ensureBootstrapped(); // objek keuangan modul (registerFinancialObjectType) harus terdaftar sebelum menyaring
  await authorize(ctx, "m10.audit_log.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const scoped: AuditQuery = { ...filter, tenantId: filter.tenantId ?? ctx.tenantId };
  const isOwner = ctx.roles.includes("owner");
  if (!isOwner && ctx.roles.includes("accountant") && !ctx.roles.includes("system_admin")) {
    const requested = scoped.objectType ? ([] as string[]).concat(scoped.objectType) : Array.from(FINANCIAL_OBJECT_TYPES);
    scoped.objectType = requested.filter((t) => FINANCIAL_OBJECT_TYPES.has(t));
    if (scoped.objectType.length === 0) return [];
  }
  const rows = await query(tx, scoped);
  // B-09 (D-09 butir 1): data pribadi pelanggan yang SUDAH DIANONIMKAN disamarkan bagi semua peran kecuali pemilik —
  // jejak tetap append-only (nilai lama tersimpan sebagai catatan wajib hukum), hanya tampilan & ekspor yang disamarkan.
  const visible = isOwner ? rows : await maskAnonymizedPii(tx, rows);
  if (!isOwner && ctx.roles.includes("system_admin")) {
    return visible.map((r) => (FINANCIAL_OBJECT_TYPES.has(r.objectType) ? { ...r, before: null, after: null } : r));
  }
  return visible;
}

// ---------------------------------------------------------------------------------------------------------------------
// Penyamaran data pribadi pelanggan yang dianonimkan (tambahan S5, B-09; D-09 butir 1, US-M10-06, RP-15)
// ---------------------------------------------------------------------------------------------------------------------

/** Nilai pengganti data pribadi di tampilan/ekspor jejak audit. */
export const AUDIT_PII_MASK = "[disamarkan — data pribadi dianonimkan]";

/**
 * Kunci data pribadi per jenis objek yang tertaut ke pelanggan (samakan dengan kolom yang dikosongkan anonimisasi M10
 * `anonymizeCustomer`). Kunci berakhiran `Lat`/`Lng` (koordinat) juga disamarkan. Append-only.
 */
export const AUDIT_CUSTOMER_PII_KEYS: Record<string, readonly string[]> = {
  customer: ["name", "waPhone", "phone", "contactName", "contactPhone", "email", "notes", "addressText", "address"],
  customer_address: ["label", "addressText", "address", "contactName", "contactPhone", "notes", "lat", "lng", "proposedLat", "proposedLng", "coordinate"],
  trip: ["recipientName", "customerName", "contactName", "customerPhone", "addressText"],
  order: ["contactName", "contactPhone", "customerName", "addressText", "notes"],
  customer_account: ["phone", "displayName", "name", "email"],
  wa_message_log: ["toPhone", "renderedText"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskValue(objectType: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const keys = new Set(AUDIT_CUSTOMER_PII_KEYS[objectType] ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const pii = keys.has(k) || /(Lat|Lng)$/.test(k);
    out[k] = pii && v !== null && v !== undefined && v !== "" ? AUDIT_PII_MASK : v;
  }
  return out;
}

/** ID objek (per jenis) yang milik pelanggan sudah dianonimkan (`customers.anonymized_at` terisi). */
async function anonymizedObjectIds(tx: Tx, rows: readonly Pick<AuditRow, "objectType" | "objectId">[]): Promise<Set<string>> {
  const idsOf = (type: string) => [...new Set(rows.filter((r) => r.objectType === type && UUID_RE.test(r.objectId)).map((r) => r.objectId))];
  const out = new Set<string>();
  const add = (type: string, found: { id: string }[]) => found.forEach((f) => out.add(`${type}:${f.id}`));
  const anon = sql`${customers.anonymizedAt} is not null`;
  const c = idsOf("customer");
  if (c.length) add("customer", await tx.select({ id: customers.id }).from(customers).where(and(inArray(customers.id, c), anon)));
  const a = idsOf("customer_address");
  if (a.length) {
    add("customer_address", await tx.select({ id: customerAddresses.id }).from(customerAddresses).innerJoin(customers, eq(customers.id, customerAddresses.customerId)).where(and(inArray(customerAddresses.id, a), anon)));
  }
  const tr = idsOf("trip");
  if (tr.length) add("trip", await tx.select({ id: trips.id }).from(trips).innerJoin(customers, eq(customers.id, trips.customerId)).where(and(inArray(trips.id, tr), anon)));
  const o = idsOf("order");
  if (o.length) add("order", await tx.select({ id: orders.id }).from(orders).innerJoin(customers, eq(customers.id, orders.customerId)).where(and(inArray(orders.id, o), anon)));
  const acc = idsOf("customer_account");
  if (acc.length) {
    add(
      "customer_account",
      await tx
        .select({ id: customerAccounts.id })
        .from(customerAccounts)
        .where(and(inArray(customerAccounts.id, acc), sql`${customerAccounts.anonymizedAt} is not null`)),
    );
  }
  const w = idsOf("wa_message_log");
  if (w.length) {
    add("wa_message_log", await tx.select({ id: waMessageLogs.id }).from(waMessageLogs).innerJoin(customers, eq(customers.id, waMessageLogs.customerId)).where(and(inArray(waMessageLogs.id, w), anon)));
  }
  return out;
}

/**
 * Samarkan nilai data pribadi pada baris jejak audit milik pelanggan yang sudah dianonimkan (nilai lama/baru). Dipakai
 * `queryForActor` (halaman `/audit`, riwayat, ekspor `core.audit_log`) untuk semua peran kecuali pemilik; modul yang
 * menampilkan riwayat audit sendiri (mis. riwayat pesanan) memanggil fungsi ini sebelum merender.
 */
export async function maskAnonymizedPii<T extends Pick<AuditRow, "objectType" | "objectId" | "before" | "after">>(tx: Tx, rows: readonly T[]): Promise<T[]> {
  const relevant = rows.filter((r) => r.objectType in AUDIT_CUSTOMER_PII_KEYS);
  if (!relevant.length) return [...rows];
  const anonymized = await anonymizedObjectIds(tx, relevant);
  if (!anonymized.size) return [...rows];
  return rows.map((r) =>
    anonymized.has(`${r.objectType}:${r.objectId}`)
      ? { ...r, before: maskValue(r.objectType, r.before) as T["before"], after: maskValue(r.objectType, r.after) as T["after"] }
      : r,
  );
}
