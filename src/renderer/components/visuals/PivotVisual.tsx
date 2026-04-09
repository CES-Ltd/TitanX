/**
 * Pivot table visual with collapsible rows/columns.
 * Renders as a styled Arco Table with grouped headers.
 */

import React, { useMemo } from 'react';
import { Table } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';

type PivotConfig = {
  rows: string[];
  cols: string[];
  values: Array<Record<string, unknown>>;
};

type PivotVisualProps = {
  config: PivotConfig;
};

const PivotVisual: React.FC<PivotVisualProps> = ({ config }) => {
  const columns: ColumnProps[] = useMemo(() => {
    const rowCols = config.rows.map((r) => ({
      title: r,
      dataIndex: r,
      fixed: 'left' as const,
      width: 140,
    }));
    const valCols = config.cols.map((c) => ({
      title: c,
      dataIndex: c,
      width: 120,
    }));
    return [...rowCols, ...valCols];
  }, [config.rows, config.cols]);

  const data = useMemo(
    () =>
      config.values.map((row, idx) => ({
        key: String(idx),
        ...row,
      })),
    [config.values]
  );

  return (
    <Table
      columns={columns}
      data={data}
      size='small'
      border={{ wrapper: true, cell: true }}
      scroll={{ x: true }}
      pagination={data.length > 20 ? { pageSize: 20 } : false}
    />
  );
};

export default PivotVisual;
