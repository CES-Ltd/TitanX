/**
 * @license Apache-2.0
 * CSV export helpers for the fleet telemetry dashboard (Phase D Week 3).
 *
 * Renderer-only. Uses an anchor-click trick to trigger a download
 * without round-tripping through the main process. Filenames encode the
 * window so multiple exports from different views don't collide.
 */

type TopDeviceRow = {
  deviceId: string;
  hostname?: string;
  costCents: number;
  activityCount: number;
  lastReportAt: number;
};

/**
 * Properly escape a single CSV field: wrap in quotes if it contains any
 * of `, " \n \r`, and double-up existing quotes inside.
 */
function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(header: string[], rows: Array<Array<string | number>>): string {
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvField).join(','));
  }
  // Final newline so the file is a valid POSIX text file.
  return `${lines.join('\n')}\n`;
}

/** Trigger a browser download of the given CSV text. */
function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Free the Blob URL once the download has been triggered.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Export the top-devices table as CSV.
 *
 * Shape:
 *   device_id, hostname, cost_usd, activity_count, last_report_iso
 *
 * Cost is emitted as dollars (cents / 100) to match what admins see in
 * the dashboard + what finance teams expect in a spreadsheet. Timestamp
 * is ISO-8601 UTC for unambiguous time zone handling.
 */
export function exportTopDevicesCsv(
  rows: TopDeviceRow[],
  ctx: { windowLabel: string; windowStart: number; windowEnd: number }
): void {
  const header = ['device_id', 'hostname', 'cost_usd', 'activity_count', 'last_report_iso'];
  const body = rows.map((r) => [
    r.deviceId,
    r.hostname ?? '',
    (r.costCents / 100).toFixed(2),
    r.activityCount,
    new Date(r.lastReportAt).toISOString(),
  ]);
  const csv = rowsToCsv(header, body);

  // Filename like "fleet-telemetry_7d_2026-04-17.csv" — the window
  // label tells the admin which slice of data this is, the date keeps
  // it unique per export attempt.
  const dateTag = new Date(ctx.windowEnd).toISOString().slice(0, 10);
  const filename = `fleet-telemetry_${ctx.windowLabel}_${dateTag}.csv`;
  downloadCsv(filename, csv);
}
