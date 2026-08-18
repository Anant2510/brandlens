'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Table, TableShell, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { SkeletonTable } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Return a comparable value to make the column sortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: string;
  className?: string;
  headerClassName?: string;
  srOnlyHeader?: boolean;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  isRowActive?: (row: T) => boolean;
  /** Client-side pagination. Omit for server-paginated lists. */
  pageSize?: number;
  initialSort?: { columnId: string; direction: 'asc' | 'desc' };
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  dense?: boolean;
  className?: string;
}

type SortState = { columnId: string; direction: 'asc' | 'desc' } | null;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  loading = false,
  error = null,
  onRetry,
  empty,
  onRowClick,
  isRowActive,
  pageSize,
  initialSort,
  selectable = false,
  selectedIds,
  onSelectionChange,
  dense = false,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = React.useState<SortState>(initialSort ?? null);
  const [page, setPage] = React.useState(1);

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.id === sort.columnId);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = column.sortValue?.(a);
      const bv = column.sortValue?.(b);
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * factor;
    });
  }, [rows, sort, columns]);

  const totalPages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const currentPage = Math.min(page, totalPages);
  const visible = pageSize ? sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize) : sorted;

  React.useEffect(() => {
    setPage(1);
  }, [rows.length, sort?.columnId, sort?.direction]);

  const toggleSort = (columnId: string) => {
    setSort((current) => {
      if (current?.columnId !== columnId) return { columnId, direction: 'asc' };
      if (current.direction === 'asc') return { columnId, direction: 'desc' };
      return null;
    });
  };

  const allVisibleSelected =
    selectable && visible.length > 0 && visible.every((row) => selectedIds?.has(rowKey(row)));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    const next = new Set(selectedIds ?? []);
    if (allVisibleSelected) {
      visible.forEach((row) => next.delete(rowKey(row)));
    } else {
      visible.forEach((row) => next.add(rowKey(row)));
    }
    onSelectionChange(next);
  };

  const toggleOne = (id: string) => {
    if (!onSelectionChange) return;
    const next = new Set(selectedIds ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  };

  if (loading) return <SkeletonTable rows={pageSize ? Math.min(pageSize, 8) : 6} cols={columns.length} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="Nothing here yet" description="No records match the current filters." />}</>;
  }

  const cellPad = dense ? 'px-2.5 py-1.5' : 'px-3 py-2';

  return (
    <div className={cn('space-y-2', className)}>
      <TableShell>
        <Table>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <THead>
            <TR className="border-b border-border">
              {selectable ? (
                <TH className={cn(cellPad, 'w-8')}>
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--accent)] cursor-pointer"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label={allVisibleSelected ? 'Deselect all rows on this page' : 'Select all rows on this page'}
                  />
                </TH>
              ) : null}
              {columns.map((column) => {
                const sortable = Boolean(column.sortValue);
                const active = sort?.columnId === column.id;
                const ariaSort = active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none';
                return (
                  <TH
                    key={column.id}
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={sortable ? ariaSort : undefined}
                    className={cn(
                      cellPad,
                      column.align === 'right' && 'text-right',
                      column.align === 'center' && 'text-center',
                      column.headerClassName,
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.id)}
                        className={cn(
                          'inline-flex items-center gap-1 hover:text-fg transition-colors',
                          column.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        <span className={column.srOnlyHeader ? 'sr-only' : undefined}>{column.header}</span>
                        {active ? (
                          sort?.direction === 'asc' ? (
                            <ArrowUp className="size-3" aria-hidden="true" />
                          ) : (
                            <ArrowDown className="size-3" aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className={column.srOnlyHeader ? 'sr-only' : undefined}>{column.header}</span>
                    )}
                  </TH>
                );
              })}
            </TR>
          </THead>
          <TBody>
            {visible.map((row) => {
              const id = rowKey(row);
              const active = isRowActive?.(row) ?? false;
              return (
                <TR
                  key={id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  aria-selected={onRowClick ? active : undefined}
                  className={cn(
                    'transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2',
                    active && 'bg-accent-soft/50',
                  )}
                >
                  {selectable ? (
                    <TD className={cellPad} onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--accent)] cursor-pointer"
                        checked={selectedIds?.has(id) ?? false}
                        onChange={() => toggleOne(id)}
                        aria-label={`Select row ${id}`}
                      />
                    </TD>
                  ) : null}
                  {columns.map((column) => (
                    <TD
                      key={column.id}
                      className={cn(
                        cellPad,
                        column.align === 'right' && 'text-right',
                        column.align === 'center' && 'text-center',
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </TD>
                  ))}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </TableShell>

      {pageSize && totalPages > 1 ? (
        <nav className="flex items-center justify-between text-xs text-fg-muted" aria-label="Table pagination">
          <p className="tabular">
            {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, sorted.length)} of {sorted.length}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
              Previous
            </Button>
            <span className="px-2 tabular">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}
