"use client";

import { Check, ChevronsUpDown, LoaderCircle, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  label: string;
  /** Baris kedua (mis. alamat, nomor WA tersamar). */
  description?: string;
  disabled?: boolean;
};

export type SearchComboboxProps<T extends ComboboxOption = ComboboxOption> = {
  /** Pilihan terpilih (objek lengkap agar label tampil tanpa memuat ulang). */
  value: T | null;
  onValueChange: (option: T | null) => void;
  /**
   * Pencarian asinkron. Dipanggil setelah ≥ `minChars` karakter dan jeda `debounceMs`. `signal` dibatalkan bila
   * ketikan berubah sebelum selesai.
   */
  search: (query: string, signal: AbortSignal) => Promise<T[]>;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Bawaan 2 karakter. */
  minChars?: number;
  /** Bawaan 300 ms. */
  debounceMs?: number;
  emptyText?: string;
  /** Render baris pilihan kustom. */
  renderOption?: (option: T) => ReactNode;
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-invalid"?: boolean;
};

type SearchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; results: T[] }
  | { status: "error" };

/**
 * Kotak pencarian dengan hasil asinkron (cmdk). Hasil muncul setelah minimal 2 karakter, dengan debounce, dan
 * permintaan lama dibatalkan. Dipakai mis. untuk memilih pelanggan saat membuat pesanan.
 */
export function SearchCombobox<T extends ComboboxOption = ComboboxOption>({
  value,
  onValueChange,
  search,
  placeholder = "Pilih…",
  searchPlaceholder = "Ketik untuk mencari…",
  minChars = 2,
  debounceMs = 300,
  emptyText = "Tidak ada yang cocok. Periksa ejaan atau coba kata lain.",
  renderOption,
  clearable,
  disabled,
  id,
  className,
  ...aria
}: SearchComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState<T>>({ status: "idle" });
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });

  const trimmed = query.trim();
  const enoughChars = trimmed.length >= minChars;

  useEffect(() => {
    if (!enoughChars) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchRef.current(trimmed, controller.signal).then(
        (results) => {
          if (!controller.signal.aborted) setState({ status: "done", results });
        },
        () => {
          if (!controller.signal.aborted) setState({ status: "error" });
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, enoughChars, debounceMs]);

  const results = enoughChars && state.status === "done" ? state.results : [];

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setState({ status: "idle" });
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={aria["aria-invalid"]}
            disabled={disabled}
            className={cn("w-full justify-between font-normal", !value && "text-muted-foreground")}
          >
            <span className="truncate">{value ? value.label : placeholder}</span>
            <ChevronsUpDown className="opacity-50" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={(next) => {
                setQuery(next);
                setState(next.trim().length >= minChars ? { status: "loading" } : { status: "idle" });
              }}
              placeholder={searchPlaceholder}
            />
            <CommandList>
              {!enoughChars ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Ketik minimal {minChars} karakter untuk mencari.
                </p>
              ) : state.status === "loading" || state.status === "idle" ? (
                <p className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground" role="status">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  Mencari…
                </p>
              ) : state.status === "error" ? (
                <p className="px-3 py-6 text-center text-sm text-destructive" role="alert">
                  Pencarian gagal. Periksa koneksi lalu ketik ulang.
                </p>
              ) : (
                <>
                  <CommandEmpty>{emptyText}</CommandEmpty>
                  <CommandGroup>
                    {results.map((option) => (
                      <CommandItem
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                        onSelect={() => {
                          onValueChange(option);
                          setOpen(false);
                          setQuery("");
                          setState({ status: "idle" });
                        }}
                      >
                        <Check
                          className={cn("mt-0.5 self-start", value?.value === option.value ? "opacity-100" : "opacity-0")}
                          aria-hidden
                        />
                        {renderOption ? (
                          renderOption(option)
                        ) : (
                          <div className="min-w-0">
                            <div className="truncate">{option.label}</div>
                            {option.description ? (
                              <div className="truncate text-xs text-muted-foreground">{option.description}</div>
                            ) : null}
                          </div>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clearable && value && !disabled ? (
        <Button type="button" variant="ghost" size="icon" aria-label="Kosongkan pilihan" onClick={() => onValueChange(null)}>
          <X aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
