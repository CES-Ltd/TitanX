/**
 * Rich data table visual with sorting, pagination, and column filters.
 */

import React, { useMemo } from 'react';
import { Input, Table } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import { Filter } from '@icon-park/react';

/** Strip markdown inline formatting from a cell value for clean display. */
function stripMd(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

type TableConfig = {
  columns: string[];
  rows: string[][];
};

type TableVisualProps = {
  config: TableConfig;
};

const TableVisual: React.FC<TableVisualProps> = ({ config }) => {
  const arcoColumns: ColumnProps[] = useMemo(
    () =>
      config.columns.map((col, idx) => ({
        title: stripMd(col),
        dataIndex: `col_${idx}`,
        sorter: (a: Record<string, string>, b: Record<string, string>) => {
          const va = a[`col_${idx}`] ?? '';
          const vb = b[`col_${idx}`] ?? '';
          const na = parseFloat(va);
          const nb = parseFloat(vb);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return va.localeCompare(vb);
        },
        filterIcon: <Filter theme='outline' size='14' />,
        filterDropdown: ({
          filterKeys,
          setFilterKeys,
          confirm,
        }: {
          filterKeys?: string[];
          setFilterKeys?: (keys: string[]) => void;
          confirm?: () => void;
        }) => (
          <div className='p-8px'>
            <Input.Search
              value={filterKeys?.[0] || ''}
              onChange={(v: string) => setFilterKeys?.(v ? [v] : [])}
              onSearch={() => confirm?.()}
              onPressEnter={() => confirm?.()}
              placeholder={`Filter ${col}`}
              size='small'
              allowClear
            />
          </div>
        ),
        onFilter: (value: string, record: Record<string, string>) => {
          return String(record[`col_${idx}`] || '')
            .toLowerCase()
            .includes(String(value).toLowerCase());
        },
      })),
    [config.columns]
  );

  const data = useMemo(
    () =>
      config.rows.map((row, rowIdx) => {
        const obj: Record<string, string> = { key: String(rowIdx) };
        row.forEach((cell, colIdx) => {
          obj[`col_${colIdx}`] = stripMd(cell);
        });
        return obj;
      }),
    [config.rows]
  );

  return (
    <Table
      columns={arcoColumns}
      data={data}
      size='small'
      border={false}
      pagination={data.length > 10 ? { pageSize: 10, sizeCanChange: true } : false}
      className='rd-8px overflow-hidden'
    />
  );
};

export default TableVisual;
