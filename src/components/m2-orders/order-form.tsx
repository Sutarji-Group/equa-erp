"use client";

import { CircleAlert, LoaderCircle, MessageCircle, Plus, UserPlus, Warehouse } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  createOrderAction,
  customerPanelAction,
  previewOrderAction,
  quickCreateCustomerAction,
  searchCustomersAction,
  sendWaAction,
  type CreateOrderActionResult,
  type CustomerOption,
  type CustomerPanel,
  type PreviewResult,
} from "@/app/(office)/pesanan/actions";
import { SearchCombobox } from "@/components/shared/search-combobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";

import { SELECT_CLASS } from "./fields";

type Defaults = { today: string; defaultDate: string; afterCutoff: boolean; sameDayCutoff: string };
type InternalTarget = { outletId: string; outletCode: string; outletName: string; customerId: string; addressId: string };
type Pay = "cash" | "transfer" | "credit";

type Pending =
  | { kind: "duplicate"; existing: Extract<CreateOrderActionResult, { status: "duplicate" }>["existing"] }
  | { kind: "credit"; message: string; canRequestApproval: boolean }
  | { kind: "after_cutoff"; message: string }
  | null;

type Created = Extract<CreateOrderActionResult, { status: "created" }> | { status: "cancelled_duplicate"; orderId: string; number: string };

/**
 * Layar pesanan baru satu halaman (US-M2-01): cari pelanggan (≥ 2 karakter), alamat bawaan = terakhir dipakai, jumlah
 * tangki, tanggal (bawaan per BR-20), jam (jam terima tetap terisi), cara bayar, catatan; harga otomatis tidak dapat
 * diubah; pelanggan baru di layar yang sama; dobel & kontrol kredit ditangani tanpa pindah halaman; setelah simpan
 * nomor besar + "Kirim konfirmasi WA". Ramah keyboard: fokus awal di pencarian, Enter menyimpan.
 */
export function OrderForm({
  defaults,
  internalTargets,
  zones,
  canCreateCustomer,
  canSendWa,
  canCreateRecurring,
}: {
  defaults: Defaults;
  internalTargets: InternalTarget[];
  zones: { id: string; code: string; name: string }[];
  canCreateCustomer: boolean;
  canSendWa: boolean;
  canCreateRecurring: boolean;
}) {
  const [mode, setMode] = useState<"customer" | "internal">("customer");
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [internalId, setInternalId] = useState<string>("");
  const [addressId, setAddressId] = useState<string>("");
  const [tankCount, setTankCount] = useState(1);
  const [requestedDate, setRequestedDate] = useState(defaults.defaultDate);
  const [requestedTime, setRequestedTime] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<Pay>("cash");
  const [notes, setNotes] = useState("");
  const [forceReason, setForceReason] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [panel, setPanel] = useState<CustomerPanel | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [dup, setDup] = useState<{ decision: "additional" | "cancel"; reason: string } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const searchWrap = useRef<HTMLDivElement>(null);

  const internal = internalTargets.find((x) => x.customerId === internalId) ?? null;
  const customerId = mode === "internal" ? (internal?.customerId ?? "") : (customer?.value ?? "");
  const effectiveAddress = mode === "internal" ? (internal?.addressId ?? "") : addressId;
  const effectivePay = mode === "internal" ? "cash" : paymentMethod;
  const sameDayAfterCutoff = requestedDate === defaults.today && defaults.afterCutoff;

  // Pratinjau harga/tempo/dobel (debounce ringan).
  useEffect(() => {
    if (!customerId || !effectiveAddress) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      const r = await previewOrderAction({ customerId, addressId: effectiveAddress, requestedDate, tankCount, paymentMethod: effectivePay });
      if (!cancelled) setPreview(r);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [customerId, effectiveAddress, requestedDate, tankCount, effectivePay]);

  useEffect(() => {
    searchWrap.current?.querySelector("button")?.focus();
  }, []);

  function selectCustomer(c: CustomerOption | null) {
    setCustomer(c);
    setPreview(null);
    setPanel(null);
    setPending(null);
    setError(null);
    setAddressId(c?.lastAddressId ?? c?.addresses[0]?.id ?? "");
    setRequestedTime(c?.fixedReceiveTime ?? "");
    setPaymentMethod("cash");
    if (c) void customerPanelAction(c.value).then(setPanel);
  }

  function reset() {
    setCustomer(null);
    setInternalId("");
    setAddressId("");
    setTankCount(1);
    setRequestedDate(defaults.defaultDate);
    setRequestedTime("");
    setPaymentMethod("cash");
    setNotes("");
    setForceReason("");
    setPreview(null);
    setPanel(null);
    setPending(null);
    setDecisionReason("");
    setDup(null);
    setCreated(null);
    setError(null);
    setTimeout(() => searchWrap.current?.querySelector("button")?.focus(), 0);
  }

  function submit(extra: { duplicate?: { decision: "additional" | "cancel"; reason: string }; creditApprovalReason?: string; paymentOverride?: Pay } = {}) {
    if (!customerId || !effectiveAddress) {
      setError("Pilih pelanggan dan alamat kirim dulu.");
      return;
    }
    setError(null);
    const duplicate = extra.duplicate ?? dup;
    if (extra.duplicate) setDup(extra.duplicate);
    startSaving(async () => {
      const pay = extra.paymentOverride ?? effectivePay;
      const res = await createOrderAction({
        customerId,
        addressId: effectiveAddress,
        tankCount,
        requestedDate,
        requestedTime: requestedTime || null,
        paymentMethod: mode === "internal" ? "internal" : pay,
        notes: notes || null,
        forceSameDayReason: sameDayAfterCutoff ? forceReason || null : null,
        duplicateDecision: duplicate?.decision ?? null,
        duplicateReason: duplicate?.decision === "additional" ? duplicate.reason : null,
        creditApprovalReason: extra.creditApprovalReason ?? null,
      });
      if (res.status === "created" || res.status === "cancelled_duplicate") {
        setCreated(res);
        setPending(null);
        if (res.status === "created") for (const w of res.warnings) toast.warning(w);
        return;
      }
      if (res.status === "duplicate") setPending({ kind: "duplicate", existing: res.existing });
      else if (res.status === "credit_blocked") {
        setDecisionReason("");
        setPending({ kind: "credit", message: res.message, canRequestApproval: res.canRequestApproval });
      }
      else if (res.code === "AFTER_CUTOFF") setPending({ kind: "after_cutoff", message: res.error });
      else setError(res.error);
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  if (created) return <CreatedView created={created} canSendWa={canSendWa} onNew={reset} />;

  const p = preview?.ok ? preview.preview : null;
  const creditSelectable = p?.creditSelectable ?? (customer ? customer.creditStatus !== "cash" : false);
  const s = panel?.ok ? panel.summary : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <form onSubmit={onSubmit} className="grid gap-5" aria-label="Pesanan baru">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Jenis pesanan">
          <Button type="button" variant={mode === "customer" ? "default" : "outline"} size="sm" onClick={() => (setMode("customer"), setPreview(null))} aria-pressed={mode === "customer"}>
            Pesanan pelanggan
          </Button>
          <Button type="button" variant={mode === "internal" ? "default" : "outline"} size="sm" onClick={() => (setMode("internal"), setPreview(null), setPanel(null))} aria-pressed={mode === "internal"}>
            <Warehouse aria-hidden />
            Pasokan depot (internal)
          </Button>
        </div>

        {mode === "customer" ? (
          <div className="grid gap-2">
            <Label htmlFor="f-customer">Pelanggan *</Label>
            <div ref={searchWrap} className="flex flex-wrap items-center gap-2">
              <SearchCombobox<CustomerOption>
                id="f-customer"
                className="min-w-0 flex-1"
                value={customer}
                onValueChange={selectCustomer}
                search={(q) => searchCustomersAction(q)}
                placeholder="Cari nama, nomor WA, atau alamat…"
                searchPlaceholder="Ketik minimal 2 karakter"
                clearable
                renderOption={(o) => (
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {o.label} {!o.isActive ? <span className="text-xs text-destructive">(nonaktif)</span> : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {label("credit_status", o.creditStatus)} · {o.description}
                    </div>
                  </div>
                )}
              />
              {canCreateCustomer ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowNewCustomer((v) => !v)} aria-expanded={showNewCustomer}>
                  <UserPlus aria-hidden />
                  Pelanggan baru
                </Button>
              ) : null}
            </div>
            {showNewCustomer ? (
              <QuickCustomer
                zones={zones}
                onCreated={(c) => {
                  setShowNewCustomer(false);
                  selectCustomer(c);
                  toast.success(`Pelanggan ${c.label} dibuat (status Tunai).`);
                }}
              />
            ) : null}
            {customer && customer.addresses.length > 0 ? (
              <fieldset className="grid gap-1.5">
                <legend className="mb-1 text-sm font-medium">Alamat kirim *</legend>
                {customer.addresses.map((a) => (
                  <label key={a.id} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm", addressId === a.id && "border-primary bg-primary/5")}>
                    <input type="radio" name="addressId" value={a.id} checked={addressId === a.id} onChange={() => setAddressId(a.id)} className="mt-1 accent-primary" />
                    <span>
                      <span className="font-medium">{a.label}</span> {a.zoneCode ? <span className="text-xs text-muted-foreground">· Zona {a.zoneCode}</span> : <span className="text-xs text-warning-foreground">· belum berzona</span>}
                      {a.id === customer.lastAddressId ? <span className="text-xs text-muted-foreground"> · terakhir dipakai</span> : null}
                      <span className="block text-muted-foreground">{a.addressText}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="f-internal">Depot tujuan (pelanggan internal) *</Label>
            <select id="f-internal" className={SELECT_CLASS} value={internalId} onChange={(e) => setInternalId(e.target.value)}>
              <option value="">Pilih depot…</option>
              {internalTargets.map((d) => (
                <option key={d.customerId} value={d.customerId}>
                  {d.outletCode} — {d.outletName}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Produk transfer internal, cara bayar Internal, tanpa pencatatan uang (PTB-01). Tampil di papan & aplikasi sopir seperti rit biasa.</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="grid gap-1.5">
            <Label htmlFor="f-tankCount">Jumlah tangki</Label>
            <Input id="f-tankCount" type="number" inputMode="numeric" min={1} max={50} value={tankCount} onChange={(e) => setTankCount(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="f-requestedDate">Tanggal diminta</Label>
            <Input id="f-requestedDate" type="date" min={defaults.today} value={requestedDate} onChange={(e) => setRequestedDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="f-requestedTime">Jam diminta</Label>
            <Input id="f-requestedTime" type="time" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)} />
            <p className="text-xs text-muted-foreground">Opsional; jam terima tetap terisi otomatis.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="f-paymentMethod">Cara bayar</Label>
            {mode === "internal" ? (
              <Input id="f-paymentMethod" value="Internal" readOnly />
            ) : (
              <select id="f-paymentMethod" className={SELECT_CLASS} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as Pay)}>
                <option value="cash">Tunai</option>
                <option value="transfer">Transfer</option>
                <option value="credit" disabled={!creditSelectable}>
                  Tempo{creditSelectable ? "" : " (tidak tersedia)"}
                </option>
              </select>
            )}
          </div>
        </div>
        {p ? <p className="-mt-3 text-xs text-muted-foreground">{p.creditNote}</p> : null}

        {sameDayAfterCutoff ? (
          <Alert>
            <CircleAlert aria-hidden />
            <AlertTitle>Sudah lewat pukul {defaults.sameDayCutoff.replace(":", ".")} (BR-20)</AlertTitle>
            <AlertDescription>
              Sistem mengusulkan kirim besok. Untuk tetap kirim hari ini, isi alasan (tercatat & ditinjau pemilik).
              <Input className="mt-2" id="f-forceReason" aria-label="Alasan paksa kirim hari ini" placeholder="Alasan kirim hari ini" value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor="f-notes">Catatan (ikut ke aplikasi sopir)</Label>
          <Textarea id="f-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Mis. isi tandon atas, hubungi satpam" />
        </div>

        <PriceBox preview={preview} tankCount={tankCount} />

        {pending?.kind === "duplicate" ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden />
            <AlertTitle>Kemungkinan pesanan dobel</AlertTitle>
            <AlertDescription>
              <p>Sudah ada pesanan untuk pelanggan, alamat, dan tanggal yang sama:</p>
              <ul className="my-2 list-disc pl-5">
                {pending.existing.map((d) => (
                  <li key={d.id}>
                    <Link href={`/pesanan/${d.id}`} className="font-medium underline">
                      {d.number}
                    </Link>{" "}
                    · {d.tankCount} tangki · {label("order_status", d.status)} · dibuat {d.createdByName ?? "—"}
                  </li>
                ))}
              </ul>
              <Input aria-label="Alasan pesanan tambahan" placeholder="Alasan pesanan tambahan (wajib)" value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={saving || decisionReason.trim().length < 3} onClick={() => submit({ duplicate: { decision: "additional", reason: decisionReason } })}>
                  Ini pesanan tambahan
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => submit({ duplicate: { decision: "cancel", reason: "" } })}>
                  Batalkan yang ini
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {pending?.kind === "credit" ? (
          <Alert variant="destructive" role="alert">
            <CircleAlert aria-hidden />
            <AlertTitle>Pesanan tempo ditolak kontrol kredit</AlertTitle>
            <AlertDescription>
              <p>{pending.message}</p>
              {pending.canRequestApproval ? (
                <Input className="mt-2" aria-label="Alasan pengajuan ke pemilik" placeholder="Alasan pengajuan ke pemilik" value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} />
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {pending.canRequestApproval ? (
                  <Button type="button" size="sm" disabled={saving || decisionReason.trim().length < 3} onClick={() => submit({ creditApprovalReason: decisionReason })}>
                    Ajukan persetujuan pemilik
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setPaymentMethod("cash");
                    submit({ paymentOverride: "cash" });
                  }}
                >
                  Ubah ke tunai & simpan
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {pending?.kind === "after_cutoff" ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{pending.message}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="lg" disabled={saving || !customerId || !effectiveAddress}>
            {saving ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            Simpan pesanan
          </Button>
          <span className="text-xs text-muted-foreground">Enter untuk menyimpan.</span>
          {canCreateRecurring ? (
            <Button asChild variant="link" size="sm">
              <Link href="/langganan">Buat pola langganan</Link>
            </Button>
          ) : null}
        </div>
      </form>

      <aside className="grid content-start gap-3" aria-label="Panel pelanggan">
        {mode === "internal" ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">Pesanan internal tidak memengaruhi piutang maupun kontrol kredit.</div>
        ) : !customer ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Pilih pelanggan untuk melihat riwayat, piutang, catatan khusus, dan harga khusus.</div>
        ) : s ? (
          <CustomerPanelView summary={s} />
        ) : panel && !panel.ok ? (
          <p className="text-sm text-destructive">{panel.error}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Memuat ringkasan pelanggan…</p>
        )}
      </aside>
    </div>
  );
}

function PriceBox({ preview, tankCount }: { preview: PreviewResult | null; tankCount: number }) {
  if (!preview) return <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Harga tampil otomatis setelah pelanggan & alamat dipilih (dari zona + BBM atau harga khusus).</div>;
  if (!preview.ok) return <Alert variant="destructive"><AlertDescription>{preview.error}</AlertDescription></Alert>;
  const p = preview.preview;
  return (
    <div className="grid gap-2">
      {p.price ? (
        <div className="rounded-lg border bg-muted/40 p-4" data-testid="harga-pesanan">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm text-muted-foreground">Harga per rit (tidak dapat diubah, BR-19)</span>
            <span className="text-lg font-semibold tabular-nums">{formatRupiah(p.price.pricePerTrip)}</span>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm text-muted-foreground">Total {tankCount} tangki</span>
            <span className="text-2xl font-bold tabular-nums">{formatRupiah(p.price.pricePerTrip * tankCount)}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{p.price.breakdown}</p>
          {p.price.provisional ? <p className="mt-1 text-xs font-medium text-warning-foreground">Harga sementara — tidak dapat diterbitkan sampai zona alamat ditetapkan.</p> : null}
        </div>
      ) : (
        <Alert variant="destructive">
          <AlertDescription>{p.priceError}</AlertDescription>
        </Alert>
      )}
      {p.credit && !p.credit.ok ? (
        <Alert variant="destructive">
          <AlertDescription>{p.credit.message}</AlertDescription>
        </Alert>
      ) : null}
      {p.underpayment.collect ? (
        <Alert>
          <AlertDescription>
            Tagih kurang bayar: {p.underpayment.openCount} faktur kurang bayar terbuka ({formatRupiah(p.underpayment.openAmount)}).
            {p.underpayment.secondUnpaid ? " Kurang bayar kedua belum lunas — pesanan hanya dapat dijadwalkan setelah lunas atau disetujui pemilik." : ""}
          </AlertDescription>
        </Alert>
      ) : null}
      {p.duplicates.length ? (
        <Alert>
          <AlertDescription>Sudah ada {p.duplicates.map((d) => d.number).join(", ")} untuk alamat & tanggal ini (kemungkinan dobel).</AlertDescription>
        </Alert>
      ) : null}
      {p.reconfirmationRequired ? (
        <Alert>
          <AlertDescription>Pelanggan mengalami rit gagal berturut (BR-24): konfirmasi ulang wajib dicatat sebelum dijadwalkan.</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function CustomerPanelView({ summary }: { summary: Extract<CustomerPanel, { ok: true }>["summary"] }) {
  return (
    <div className="grid gap-3 rounded-lg border p-4 text-sm">
      <div>
        <p className="font-semibold">{summary.name}</p>
        <p className="text-muted-foreground">
          {label("customer_segment", summary.segment)} · {label("credit_status", summary.creditStatus)}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2">
        <div>
          <dt className="text-xs text-muted-foreground">Piutang terbuka</dt>
          <dd className="tabular-nums">{formatRupiah(summary.openReceivable)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Batas tersisa</dt>
          <dd className={cn("tabular-nums", summary.remainingLimit < 0 && "text-destructive")}>{summary.creditStatus === "cash" ? "—" : formatRupiah(summary.remainingLimit)}</dd>
        </div>
      </dl>
      {summary.notes || summary.fixedReceiveTime ? (
        <div className="rounded-md bg-muted/50 p-2">
          <p className="text-xs font-medium">Catatan khusus</p>
          {summary.fixedReceiveTime ? <p>Jam terima tetap {summary.fixedReceiveTime.slice(0, 5)}</p> : null}
          {summary.notes ? <p>{summary.notes}</p> : null}
        </div>
      ) : null}
      {summary.activeSpecialPrices.length ? (
        <div>
          <p className="text-xs font-medium">Harga khusus berlaku</p>
          {summary.activeSpecialPrices.map((sp) => (
            <p key={sp.id}>
              {sp.productName}: {formatRupiah(sp.price)}
            </p>
          ))}
        </div>
      ) : null}
      <div>
        <p className="mb-1 text-xs font-medium">10 pesanan terakhir</p>
        {summary.lastOrders.length === 0 ? (
          <p className="text-muted-foreground">Belum ada pesanan.</p>
        ) : (
          <ul className="grid gap-1">
            {summary.lastOrders.map((o) => (
              <li key={o.id} className="flex flex-wrap justify-between gap-1">
                <Link href={`/pesanan/${o.id}`} className="text-primary underline-offset-4 hover:underline">
                  {formatTanggal(o.requestedDate, { weekday: false })}
                </Link>
                <span className="text-muted-foreground">
                  {o.tankCount} tangki · {label("order_status", o.status)}
                  {o.trucks.length ? ` · ${o.trucks.join(", ")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {summary.averageDaysBetweenOrders ? <p className="mt-1 text-xs text-muted-foreground">Rata-rata tiap {summary.averageDaysBetweenOrders} hari.</p> : null}
      </div>
    </div>
  );
}

function QuickCustomer({ zones, onCreated }: { zones: { id: string; code: string; name: string }[]; onCreated: (c: CustomerOption) => void }) {
  const [name, setName] = useState("");
  const [waPhone, setWaPhone] = useState("");
  const [segment, setSegment] = useState("household");
  const [addressText, setAddressText] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dups, setDups] = useState<{ customerId: string; name: string; reasonText: string }[]>([]);
  const [busy, start] = useTransition();
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/30 p-3" role="group" aria-label="Pelanggan baru">
      <p className="text-sm font-medium">Pelanggan baru (otomatis Tunai; kelengkapan lain di Data master)</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="Nama pelanggan" placeholder="Nama" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="Nomor WA" placeholder="Nomor WA (0812…)" value={waPhone} onChange={(e) => setWaPhone(e.target.value)} inputMode="tel" />
        <select aria-label="Segmen" className={SELECT_CLASS} value={segment} onChange={(e) => setSegment(e.target.value)}>
          {enumOptions("customer_segment").map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select aria-label="Zona (bila belum ada koordinat)" className={SELECT_CLASS} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
          <option value="">Zona: tentukan kemudian (harga sementara)</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.code} — {z.name}
            </option>
          ))}
        </select>
        <Input className="sm:col-span-2" aria-label="Alamat kirim" placeholder="Alamat kirim" value={addressText} onChange={(e) => setAddressText(e.target.value)} />
      </div>
      {dups.length ? (
        <div className="text-sm">
          <p>Pelanggan mirip:</p>
          <ul className="list-disc pl-5">
            {dups.map((d) => (
              <li key={d.customerId}>
                {d.name} — {d.reasonText}
              </li>
            ))}
          </ul>
          <label className="mt-1 flex items-center gap-2">
            <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} className="accent-primary" /> Tetap buat baru
          </label>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await quickCreateCustomerAction({ name, waPhone, segment, addressText, manualZoneId: zoneId || null, confirmDuplicate });
              if (r.ok) onCreated(r.customer);
              else {
                setError(r.error);
                setDups(r.duplicates ?? []);
              }
            })
          }
        >
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          Simpan pelanggan
        </Button>
      </div>
    </div>
  );
}

function CreatedView({ created, canSendWa, onNew }: { created: Created; canSendWa: boolean; onNew: () => void }) {
  const [busy, start] = useTransition();
  const newRef = useRef<HTMLButtonElement>(null);
  useEffect(() => newRef.current?.focus(), []);
  if (created.status === "cancelled_duplicate") {
    return (
      <div className="grid gap-4 rounded-lg border p-6">
        <p className="text-sm text-muted-foreground">Pesanan tidak dilanjutkan (dobel) dan tercatat Dibatalkan untuk laporan KPI-06:</p>
        <p className="text-3xl font-bold tabular-nums">{created.number}</p>
        <div className="flex flex-wrap gap-2">
          <Button ref={newRef} onClick={onNew}>
            Pesanan baru lagi
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-4 rounded-lg border p-6" data-testid="pesanan-tersimpan">
      <p className="text-sm text-muted-foreground">Pesanan tersimpan{created.orderStatus === "awaiting_approval" ? " — menunggu persetujuan pemilik" : ""}</p>
      <p className="text-5xl font-bold tracking-tight tabular-nums sm:text-6xl" aria-label="Nomor pesanan">
        {created.number}
      </p>
      <p className="text-muted-foreground">
        {created.tankCount} tangki · total {formatRupiah(created.totalAmount)}
        {created.approvalNumbers.length ? ` · permintaan ${created.approvalNumbers.join(", ")}` : ""}
      </p>
      {created.warnings.length ? (
        <ul className="list-disc pl-5 text-sm text-warning-foreground">
          {created.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canSendWa ? (
          <Button
            variant="default"
            disabled={busy}
            onClick={() =>
              start(async () => {
                const r = await sendWaAction(created.orderId);
                if (r.error) toast.error(r.error);
                else {
                  if (r.link) window.open(r.link, "_blank", "noopener");
                  if (r.message) toast.success(r.message);
                  for (const w of r.warnings ?? []) toast.warning(w);
                }
              })
            }
          >
            <MessageCircle aria-hidden />
            Kirim konfirmasi WA
          </Button>
        ) : null}
        <Button ref={newRef} variant="outline" onClick={onNew}>
          <Plus aria-hidden />
          Pesanan baru lagi
        </Button>
        <Button asChild variant="ghost">
          <Link href={`/pesanan/${created.orderId}`}>Lihat rincian</Link>
        </Button>
      </div>
    </div>
  );
}
