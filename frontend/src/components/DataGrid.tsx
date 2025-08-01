import '@/rdg.css';
import React, { useMemo, useState, useCallback } from 'react';
import ReactDataGrid, {
  Column,
  SortColumn,
  SelectColumn,
  SELECT_COLUMN_KEY,
} from 'react-data-grid';
import { Button } from '@/components/radix/Button';
import { Badge } from '@/components/radix/Badge';
import { Copy, Check, MoveUp, MoveDown } from 'lucide-react';
import { cn } from '@/lib/utils/utils';
import { PaginationControls } from './PaginationControls';

// Types
export interface DataGridColumn {
  key: string;
  name: string;
  type?: string;
  width?: number | string;
  minWidth?: number;
  maxWidth?: number;
  resizable?: boolean;
  sortable?: boolean;
  editable?: boolean;
  primary_key?: boolean;
  renderCell?: (props: any) => React.ReactNode;
  renderEditCell?: (props: any) => React.ReactNode;
  renderHeaderCell?: (props: any) => React.ReactNode;
}

export interface DataGridProps {
  data: any[];
  columns: DataGridColumn[];
  loading?: boolean;
  isSorting?: boolean;
  isRefreshing?: boolean;
  selectedRows?: Set<string>;
  onSelectedRowsChange?: (selectedRows: Set<string>) => void;
  sortColumns?: SortColumn[];
  onSortColumnsChange?: (sortColumns: SortColumn[]) => void;
  onCellEdit?: (rowId: string, columnKey: string, newValue: any) => Promise<void>;
  searchQuery?: string;
  currentPage?: number;
  totalPages?: number;
  pageSize?: number;
  totalRecords?: number;
  onPageChange?: (page: number) => void;
  onDeleteRecord?: (id: string) => void;
  onNewRecord?: () => void;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateActionText?: string;
  onEmptyStateAction?: () => void;
  emptyStateIcon?: React.ReactNode;
  emptyStateAction?: React.ReactNode;
  rowKeyGetter?: (row: any) => string;
  className?: string;
  showSelection?: boolean;
  showPagination?: boolean;
  showTypeBadge?: boolean;
}

// Default cell renderers
export const DefaultCellRenderers = {
  text: ({ row, column }: any) => (
    <div className="w-full h-full flex items-center">
      <span className="truncate" title={String(row[column.key] || 'null')}>
        {row[column.key] || 'null'}
      </span>
    </div>
  ),

  boolean: ({ row, column }: any) => {
    const value = row[column.key];
    return (
      <div className="w-full h-full flex items-center justify-start">
        <Badge variant={value ? 'default' : 'secondary'}>
          {value === null ? 'null' : value ? 'true' : 'false'}
        </Badge>
      </div>
    );
  },

  date: ({ row, column }: any) => {
    const value = row[column.key];
    if (!value) {
      return <span className="text-black">null</span>;
    }

    try {
      const date = new Date(value);
      return (
        <div className="w-full h-full flex items-center">
          <span className="truncate" title={date.toLocaleString()}>
            {date.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      );
    } catch {
      return <span className="text-red-500">Invalid date</span>;
    }
  },

  json: ({ row, column }: any) => {
    const value = row[column.key];
    let displayText = 'null';

    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (parsed && typeof parsed === 'object') {
        displayText = JSON.stringify(parsed);
      } else {
        displayText = String(parsed);
      }
    } catch {
      displayText = 'Invalid JSON';
    }

    return (
      <div className="w-full h-full flex items-center">
        <span
          className="truncate text-sm text-black max-w-full overflow-hidden whitespace-nowrap"
          title={displayText}
        >
          {displayText}
        </span>
      </div>
    );
  },

  id: ({ row, column }: any) => {
    const value = row[column.key];

    return <IdCell value={value} />;
  },

  email: ({ row, column }: any) => (
    <span className="text-sm text-gray-800 font-medium truncate" title={row[column.key] || 'null'}>
      {row[column.key] || 'null'}
    </span>
  ),

  badge: ({ row, column, options }: any) => {
    const value = row[column.key];
    const variant = options?.getVariant ? options.getVariant(value) : 'secondary';
    const label = options?.getLabel ? options.getLabel(value) : value;

    return (
      <div className="w-full h-full flex items-center">
        <Badge variant={variant} className="text-xs">
          {label}
        </Badge>
      </div>
    );
  },
};

// Separate IdCell component to use hooks properly
function IdCell({ value }: { value: any }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copy failed silently
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-between group">
      <span className="font-mono text-sm text-gray-500 truncate" title={String(value)}>
        {value}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
        onClick={(e) => {
          handleCopy(e).catch(() => {
            // Handle copy error silently
          });
        }}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-600" />
        ) : (
          <Copy className="h-3 w-3 text-gray-400" />
        )}
      </Button>
    </div>
  );
}

// Default header renderer
export function SortableHeaderRenderer({
  column,
  sortDirection,
  columnType,
  showTypeBadge,
}: {
  column: any;
  sortDirection?: 'ASC' | 'DESC';
  columnType?: string;
  showTypeBadge?: boolean;
}) {
  const getTypeDisplayName = (type: string) => {
    const typeMap: { [key: string]: string } = {
      text: 'text',
      varchar: 'text',
      'character varying': 'text',
      integer: 'number',
      bigint: 'number',
      'double precision': 'number',
      boolean: 'boolean',
      'timestamp with time zone': 'date',
      timestamptz: 'date',
      jsonb: 'json',
      json: 'json',
      uuid: 'uuid',
    };
    return typeMap[type?.toLowerCase()] || 'text';
  };

  const typeDisplay = columnType ? getTypeDisplayName(columnType) : '';
  const isIdColumn = column.key === 'id';

  // Determine which arrow to show on hover based on current sort state
  const getNextSortDirection = () => {
    if (!sortDirection) {
      return 'DESC'; // Default to DESC for first sort
    }
    return sortDirection === 'DESC' ? 'ASC' : 'DESC'; // Toggle direction
  };

  const nextDirection = getNextSortDirection();
  const ArrowIcon = nextDirection === 'DESC' ? MoveDown : MoveUp;

  return (
    <div className="group w-full h-full flex items-center cursor-pointer">
      <div className="flex flex-row gap-1 items-center">
        <span className="truncate text-sm font-medium text-zinc-950">{column.name}</span>

        {columnType && !isIdColumn && showTypeBadge && (
          <span className="bg-white px-1.5 py-0.5 border border-border-gray rounded-[6px] text-xs text-zinc-500 font-normal">
            {typeDisplay}
          </span>
        )}
        {isIdColumn && showTypeBadge && (
          <span className="bg-white px-1.5 py-0.5 border border-border-gray rounded-[6px] text-xs text-zinc-500 font-normal">
            UUID
          </span>
        )}

        {/* Show sort arrow only on hover if column is sortable */}
        {column.sortable && (
          <ArrowIcon
            className={`ml-0.5 h-4 w-4 text-zinc-500 transition-opacity ${
              sortDirection
                ? 'opacity-100' // Always show if currently sorted
                : 'opacity-0 group-hover:opacity-100' // Show on hover if not sorted
            }`}
          />
        )}
      </div>
    </div>
  );
}

// Main DataGrid component
export function DataGrid({
  data,
  columns,
  loading = false,
  isSorting = false,
  isRefreshing = false,
  selectedRows,
  onSelectedRowsChange,
  sortColumns,
  onSortColumnsChange,
  // onCellEdit,
  searchQuery: _searchQuery,
  currentPage,
  totalPages,
  pageSize,
  totalRecords,
  onPageChange,
  onDeleteRecord: _onDeleteRecord,
  onNewRecord: _onNewRecord,
  emptyStateTitle = 'No data available',
  emptyStateDescription: _emptyStateDescription,
  emptyStateActionText,
  onEmptyStateAction,
  emptyStateIcon: _emptyStateIcon,
  emptyStateAction: _emptyStateAction,
  rowKeyGetter,
  className,
  showSelection = false,
  showPagination = true,
  showTypeBadge = true,
}: DataGridProps) {
  // Convert columns to react-data-grid format
  const gridColumns = useMemo(() => {
    const cols: Column<any>[] = [];

    // Add selection column if enabled (not fixed anymore)
    if (showSelection && selectedRows !== undefined && onSelectedRowsChange) {
      cols.push({
        ...SelectColumn,
        key: SELECT_COLUMN_KEY,
        frozen: true,
        width: 45,
        minWidth: 45,
        maxWidth: 45,
        resizable: false,
        renderCell: ({ row, tabIndex }) => (
          <div className="w-full h-full flex items-center justify-center">
            <input
              type="checkbox"
              className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
              checked={selectedRows.has(row.id)}
              onChange={(e) => {
                const newSelectedRows = new Set(selectedRows);
                if (e.target.checked) {
                  newSelectedRows.add(row.id);
                } else {
                  newSelectedRows.delete(row.id);
                }
                onSelectedRowsChange(newSelectedRows);
              }}
              tabIndex={tabIndex}
            />
          </div>
        ),
        renderHeaderCell: () => (
          <div className="w-full h-full flex items-center justify-center">
            <input
              type="checkbox"
              className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 focus:ring-2"
              checked={data.length > 0 && data.every((row) => selectedRows.has(row.id))}
              onChange={(e) => {
                const newSelectedRows = new Set(selectedRows);
                if (e.target.checked) {
                  data.forEach((row) => newSelectedRows.add(row.id));
                } else {
                  data.forEach((row) => newSelectedRows.delete(row.id));
                }
                onSelectedRowsChange(newSelectedRows);
              }}
            />
          </div>
        ),
      });
    }

    // Add data columns
    columns.forEach((col) => {
      const currentSort = sortColumns?.find((sort) => sort.columnKey === col.key);
      const sortDirection = currentSort?.direction;

      const gridColumn: Column<any> = {
        key: col.key,
        name: col.name,
        width: col.width,
        minWidth: col.minWidth || 80,
        maxWidth: col.maxWidth,
        resizable: col.resizable !== false,
        sortable: col.sortable !== false,
        editable: col.editable && !col.primary_key,
        renderCell: col.renderCell || DefaultCellRenderers.text,
        renderEditCell: col.renderEditCell,
        renderHeaderCell:
          col.renderHeaderCell ||
          (({ column }: { column: any }) => (
            <SortableHeaderRenderer
              column={column}
              sortDirection={sortDirection}
              columnType={col.type}
              showTypeBadge={showTypeBadge}
            />
          )),
      };

      cols.push(gridColumn);
    });

    return cols;
  }, [columns, selectedRows, onSelectedRowsChange, data, sortColumns, showSelection]);

  // Default row key getter
  const defaultRowKeyGetter = useCallback(
    (row: any) => row.id || row.key || Math.random().toString(),
    []
  );
  const keyGetter = rowKeyGetter || defaultRowKeyGetter;

  // Loading state - only show full loading screen if not sorting
  if (loading && !isSorting) {
    return (
      <div className="h-full flex items-center justify-center bg-white">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className={cn('h-full flex flex-col bg-white', className)}>
      <div className="flex-1 overflow-hidden relative">
        <ReactDataGrid
          columns={gridColumns}
          rows={data || []}
          rowKeyGetter={keyGetter}
          onRowsChange={() => {}}
          selectedRows={selectedRows}
          onSelectedRowsChange={onSelectedRowsChange}
          sortColumns={sortColumns || []}
          onSortColumnsChange={onSortColumnsChange}
          className="h-full rdg-light fill-grid"
          headerRowHeight={52}
          rowHeight={52}
          enableVirtualization={true}
          renderers={{
            noRowsFallback: (
              <div className="absolute inset-x-0 top-0 mt-13 py-8 flex items-center justify-center bg-white">
                <div className="flex flex-row gap-2.5 items-center">
                  <div className="text-sm text-zinc-500">{emptyStateTitle}</div>
                  {emptyStateActionText && onEmptyStateAction && (
                    <button
                      onClick={onEmptyStateAction}
                      className="inline-flex items-center text-sm font-medium text-chart-blue-dark focus:outline-none focus:ring-0"
                    >
                      {emptyStateActionText}
                    </button>
                  )}
                </div>
              </div>
            ),
          }}
        />

        {/* Loading mask overlay */}
        {isRefreshing && (
          <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-50 mt-13">
            <div className="flex items-center gap-1">
              <div className="w-5 h-5 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-zinc-500">Loading</span>
            </div>
          </div>
        )}
      </div>
      {showPagination && onPageChange && (
        <PaginationControls
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={onPageChange}
          totalRecords={totalRecords}
          pageSize={pageSize}
        />
      )}
    </div>
  );
}
