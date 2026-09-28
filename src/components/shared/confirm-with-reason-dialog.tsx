"use client";

import { LoaderCircle } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ReasonOption = { code: string; label: string };

export type ReasonResult = {
  /** Kode alasan terpilih (`null` bila hanya teks bebas). */
  reasonCode: string | null;
  /** Teks tambahan/teks bebas (sudah di-trim; boleh kosong bila kode bukan "lainnya"). */
  reasonText: string;
  /** Alasan siap simpan: label kode (+ `": " + teks` bila ada) atau teks bebas. */
  reason: string;
};

export type ReasonValidationInput = {
  reasons?: readonly ReasonOption[];
  otherCode?: string;
  minLength?: number;
  reasonCode: string | null;
  reasonText: string;
};

/**
 * Validasi alasan (murni, dapat diuji). Mengembalikan pesan kesalahan berisi tindakan, atau `null` bila sah.
 * - Tanpa daftar kode: teks wajib, minimal `minLength` karakter.
 * - Dengan daftar kode: kode wajib dipilih; bila kode = `otherCode`, teks wajib.
 */
export function validateReason({
  reasons,
  otherCode = "other",
  minLength = 3,
  reasonCode,
  reasonText,
}: ReasonValidationInput): string | null {
  const text = reasonText.trim();
  if (reasons && reasons.length > 0) {
    if (!reasonCode || !reasons.some((r) => r.code === reasonCode)) return "Pilih salah satu alasan.";
    if (reasonCode === otherCode && text.length < minLength) {
      return `Tuliskan alasan lainnya (minimal ${minLength} karakter).`;
    }
    return null;
  }
  if (text.length < minLength) return `Tuliskan alasan (minimal ${minLength} karakter).`;
  return null;
}

/** Susun hasil alasan dari masukan yang sudah sah. */
export function buildReasonResult(
  reasons: readonly ReasonOption[] | undefined,
  otherCode: string,
  reasonCode: string | null,
  reasonText: string,
): ReasonResult {
  const text = reasonText.trim();
  if (reasons && reasons.length > 0 && reasonCode) {
    const option = reasons.find((r) => r.code === reasonCode);
    if (reasonCode === otherCode) return { reasonCode, reasonText: text, reason: text };
    const base = option?.label ?? reasonCode;
    return { reasonCode, reasonText: text, reason: text ? `${base}: ${text}` : base };
  }
  return { reasonCode: null, reasonText: text, reason: text };
}

export type ConfirmWithReasonDialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Elemen pemicu (tombol) — opsional bila `open` dikendalikan. */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Daftar kode alasan (mis. salah produk, salah jumlah, …). Kosong = teks bebas saja. */
  reasons?: readonly ReasonOption[];
  /** Kode untuk "Lainnya" (wajib teks). Bawaan `"other"`; ditambahkan otomatis bila belum ada di `reasons`. */
  otherCode?: string;
  otherLabel?: string;
  /** Panjang minimal teks alasan. Bawaan 3. */
  minLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Gaya tombol konfirmasi merah (tolak/void). */
  destructive?: boolean;
  /** Label kolom teks. */
  textLabel?: string;
  textPlaceholder?: string;
  /** Dipanggil hanya bila alasan sah. Boleh async; galat yang dilempar ditampilkan sebagai pesan. */
  onConfirm: (result: ReasonResult) => void | Promise<void>;
  /** Isi tambahan di atas kolom alasan (ringkasan objek, nilai). */
  children?: ReactNode;
};

/**
 * Dialog konfirmasi dengan ALASAN WAJIB (penolakan persetujuan, void, koreksi, pengesampingan beralasan).
 * Tombol konfirmasi tidak menjalankan `onConfirm` sebelum alasan sah; pesan kesalahan tampil di bawah kolom.
 */
export function ConfirmWithReasonDialog({
  open: openProp,
  onOpenChange,
  trigger,
  title,
  description,
  reasons,
  otherCode = "other",
  otherLabel = "Lainnya",
  minLength = 3,
  confirmLabel = "Simpan",
  cancelLabel = "Batal",
  destructive,
  textLabel,
  textPlaceholder,
  onConfirm,
  children,
}: ConfirmWithReasonDialogProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const baseId = useId();

  const options: ReasonOption[] | undefined =
    reasons && reasons.length > 0
      ? reasons.some((r) => r.code === otherCode)
        ? [...reasons]
        : [...reasons, { code: otherCode, label: otherLabel }]
      : undefined;
  const showText = !options || reasonCode !== null;
  const textRequired = !options || reasonCode === otherCode;

  function setOpen(next: boolean) {
    if (!next) {
      setReasonCode(null);
      setReasonText("");
      setError(null);
      setSubmitting(false);
    }
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  }

  async function handleConfirm() {
    const message = validateReason({ reasons: options, otherCode, minLength, reasonCode, reasonText });
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm(buildReasonResult(options, otherCode, reasonCode, reasonText));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Gagal menyimpan. Coba lagi.");
      setSubmitting(false);
    }
  }

  const errorId = `${baseId}-error`;
  const textId = `${baseId}-text`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">Alasan wajib diisi.</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void handleConfirm();
          }}
        >
          {children}
          {options ? (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Alasan</legend>
              <RadioGroup
                value={reasonCode ?? ""}
                onValueChange={(v) => {
                  setReasonCode(v);
                  setError(null);
                }}
                aria-describedby={error ? errorId : undefined}
                aria-invalid={error ? true : undefined}
              >
                {options.map((o) => {
                  const optionId = `${baseId}-${o.code}`;
                  return (
                    <div key={o.code} className="flex items-center gap-2">
                      <RadioGroupItem value={o.code} id={optionId} />
                      <Label htmlFor={optionId} className="font-normal">
                        {o.label}
                      </Label>
                    </div>
                  );
                })}
              </RadioGroup>
            </fieldset>
          ) : null}
          {showText ? (
            <div className="grid gap-2">
              <Label htmlFor={textId}>
                {textLabel ?? (options ? (textRequired ? "Tuliskan alasan" : "Keterangan (opsional)") : "Alasan")}
              </Label>
              <Textarea
                id={textId}
                value={reasonText}
                onChange={(e) => {
                  setReasonText(e.target.value);
                  setError(null);
                }}
                placeholder={textPlaceholder ?? "Jelaskan alasannya secara singkat"}
                aria-invalid={error && textRequired ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                aria-required={textRequired}
                rows={3}
              />
            </div>
          ) : null}
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={submitting} className={cn(submitting && "cursor-wait")}>
              {submitting ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
