"use client";

import {
  type ColumnDef,
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  type RowData,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, SearchX } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { EmptyState } from "./empty-state";
import { TableSkeleton } from "./loading-skeletons";

/** Metadata kolom DataTable (per kolom, lewat `meta`). */
export type DataTableColumnMeta = {
  /** Perataan sel; angka rupiah/liter → `"right"`. */
  align?: "left" | "center" | "right";
  /** Sembunyikan kolom di ponsel (< md) agar tidak perlu gulir mendatar. */
  hideOnMobile?: boolean;
  /** Ikut pencarian teks (bawaan `true` untuk kolom ber-accessor). */
  searchable?: boolean;
  className?: string;
  headerClassName?: string;
};

/** Fitur TanStack Table v9 yang dipakai DataTable: urut, filter teks global, paginasi. */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic, datetime: sortFn_datetime },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;

/** Definisi kolom DataTable. Buat dengan `dataTableColumns<T>()` agar tipe nilai terjaga. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataTableColumnDef<TData extends RowData> = ColumnDef<DataTableFeatures, TData, any>;

/**
 * Pembantu kolom bertipe. Contoh:
 * ```ts
 * const col = dataTableColumns<OrderRow>();
 * const columns = col.columns([
 *   col.accessor("number", { header: "Nomor" }),
 *   col.accessor("total", { header: "Total", cell: (c) => <MoneyText value={c.getValue()} />, meta: { align: "right" } }),
 * ]);
 * ```
 * Definisikan `columns` di luar komponen atau dengan `useMemo` agar referensinya stabil.
 */
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

export type DataTableProps<TData extends RowData> = {
  columns: DataTableColumnDef<TData>[];
  data: TData[];
  /** ID baris stabil (disarankan: ID entitas). */
  getRowId?: (row: TData, index: number) => string;
  /** Tampilkan kotak pencarian teks (filter global di sisi klien). Bawaan `true`. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Ukuran halaman awal. Bawaan 25. */
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  /** Urutan awal, mis. `[{ id: "createdAt", desc: true }]`. */
  initialSorting?: SortingState;
  /** Baris dapat diklik: panggil fungsi ini. */
  onRowClick?: (row: TData) => void;
  /** Baris dapat diklik: navigasi ke URL ini (prioritas di bawah `onRowClick`). */
  rowHref?: (row: TData) => string;
  /** Slot filter tambahan di sebelah kotak pencarian (Select status, DateInput, …). */
  toolbar?: ReactNode;
  /** Slot tombol ekspor (mis. `<ExportButtons excelHref=… />`). */
  exportSlot?: ReactNode;
  /** Keadaan kosong saat data memang kosong (bukan hasil pencarian). */
  emptyState?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Tampilkan kerangka memuat. */
  loading?: boolean;
  /** Keterangan tabel untuk pembaca layar. */
  caption?: string;
  /** Kelas tambahan per baris (mis. menonjolkan selisih). */
  rowClassName?: (row: TData) => string | undefined;
  className?: string;
};

const DEFAULT_PAGE_SIZES = [10, 25, 50, 100] as const;
const ALIGN: Record<NonNullable<DataTableColumnMeta["align"]>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function isInteractiveTarget(e: MouseEvent | KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  return !!target?.closest("a,button,input,select,textarea,label,[role=checkbox],[role=menuitem],[data-row-click-ignore]");
}

/**
 * Tabel data web kantor (TanStack Table v9): urut per kolom, pencarian teks, paginasi, keadaan kosong, slot ekspor,
 * dan baris yang dapat diklik. Semua pemrosesan di sisi klien — untuk data besar, kirim data per halaman dari server
 * dan buat tabel khusus dengan `manualPagination`.
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  searchable = true,
  searchPlaceholder = "Cari…",
  pageSize = 25,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  initialSorting,
  onRowClick,
  rowHref,
  toolbar,
  exportSlot,
  emptyState,
  emptyTitle = "Belum ada data",
  emptyDescription,
  loading,
  caption,
  rowClassName,
  className,
}: DataTableProps<TData>) {
  const router = useRouter();
  const [initialState] = useState(() => ({
    sorting: initialSorting ?? [],
    pagination: { pageIndex: 0, pageSize },
    globalFilter: "",
  }));

  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    initialState,
    globalFilterFn: "includesString",
    getColumnCanGlobalFilter: (column) => (column.columnDef.meta as DataTableColumnMeta | undefined)?.searchable !== false,
    enableSortingRemoval: false,
  });

  const globalFilter = String(table.state.globalFilter ?? "");
  const { pageIndex, pageSize: currentPageSize } = table.state.pagination;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const rows = table.getRowModel().rows;
  const clickable = !!onRowClick || !!rowHref;
  const visibleColumnCount = table.getAllLeafColumns().length;

  function activate(row: TData) {
    if (onRowClick) onRowClick(row);
    else if (rowHref) router.push(rowHref(row));
  }

  const from = filteredCount === 0 ? 0 : pageIndex * currentPageSize + 1;
  const to = Math.min(filteredCount, (pageIndex + 1) * currentPageSize);

  return (
    <div data-slot="data-table" className={cn("flex min-w-0 flex-col gap-3", className)}>
      {searchable || toolbar || exportSlot ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {searchable ? (
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <Search aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={globalFilter}
                onChange={(e) => table.setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label="Cari di tabel"
              />
            </InputGroup>
          ) : null}
          {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}
          {exportSlot ? <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{exportSlot}</div> : null}
        </div>
      ) : null}

      {loading ? (
        <TableSkeleton columns={Math.min(visibleColumnCount, 6)} />
      ) : data.length === 0 ? (
        (emptyState ?? <EmptyState title={emptyTitle} description={emptyDescription} />)
      ) : (
        <div className="rounded-md border">
          <Table>
            {caption ? <caption className="sr-only">{caption}</caption> : null}
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => {
                    const meta = header.column.columnDef.meta;
                    const sorted = header.column.getIsSorted();
                    const canSort = header.column.getCanSort();
                    return (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                        className={cn(
                          meta?.align && ALIGN[meta.align],
                          meta?.hideOnMobile && "hidden md:table-cell",
                          meta?.headerClassName,
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={cn(
                              "-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                              meta?.align === "right" && "flex-row-reverse",
                            )}
                          >
                            <table.FlexRender header={header} />
                            {sorted === "asc" ? (
                              <ArrowUp className="size-3.5" aria-hidden />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="size-3.5" aria-hidden />
                            ) : (
                              <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                            )}
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={visibleColumnCount}>
                    <EmptyState
                      compact
                      icon={SearchX}
                      title="Tidak ada yang cocok"
                      description="Ubah kata pencarian atau filter."
                      action={
                        globalFilter ? (
                          <Button variant="outline" size="sm" onClick={() => table.setGlobalFilter("")}>
                            Hapus pencarian
                          </Button>
                        ) : undefined
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-clickable={clickable || undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={
                      clickable
                        ? (e) => {
                            if (!isInteractiveTarget(e)) activate(row.original);
                          }
                        : undefined
                    }
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if ((e.key === "Enter" || e.key === " ") && !isInteractiveTarget(e)) {
                              e.preventDefault();
                              activate(row.original);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      clickable && "cursor-pointer focus-visible:bg-muted focus-visible:outline-none",
                      rowClassName?.(row.original),
                    )}
                  >
                    {row.getAllCells().map((cell) => {
                      const meta = cell.column.columnDef.meta;
                      return (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            meta?.align && ALIGN[meta.align],
                            meta?.align === "right" && "tabular",
                            meta?.hideOnMobile && "hidden md:table-cell",
                            meta?.className,
                          )}
                        >
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {!loading && data.length > 0 ? (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p aria-live="polite">
            {filteredCount === 0 ? "0 baris" : `Menampilkan ${from}–${to} dari ${filteredCount} baris`}
            {globalFilter && filteredCount !== data.length ? ` (disaring dari ${data.length})` : ""}
          </p>
          <div className="flex items-center gap-2">
            <Select value={String(currentPageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
              <SelectTrigger size="sm" aria-label="Baris per halaman" className="w-[6.5rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} baris
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              aria-label="Halaman sebelumnya"
            >
              <ChevronLeft aria-hidden />
            </Button>
            <span className="tabular min-w-16 text-center">
              {pageIndex + 1} / {Math.max(1, table.getPageCount())}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              aria-label="Halaman berikutnya"
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
