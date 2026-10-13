import { UsageError } from '../../core/provider/errors.js';

export interface OutputOptions { json?: boolean; quiet?: boolean; tty?: boolean; width?: number; noColor?: boolean }
export function outputMode(options: OutputOptions): 'json' | 'quiet' | 'table' | 'tsv' {
  if (options.json && options.quiet) throw new UsageError('--json and --quiet cannot be combined');
  return options.json ? 'json' : options.quiet ? 'quiet' : options.tty ? 'table' : 'tsv';
}
export function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
export function displayDate(iso: string | undefined, tty: boolean): string {
  if (!iso) return '';
  if (!tty) return iso;
  const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const clean = (value: unknown): string => value === undefined || value === null ? '' : String(value).replace(/[\t\r\n]+/g, ' ');
export function table(columns: string[], values: unknown[][], options: OutputOptions = {}): string {
  const rows = values.map(row => row.map(value => clean(typeof value === 'boolean' && options.tty ? value ? 'yes' : 'no' : value)));
  if (!options.tty) return rows.map(row => row.join('\t')).join('\n') + (rows.length ? '\n' : '');
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map(row => [...(row[i] ?? '')].length)));
  const flexible = new Set(['title', 'name', 'album', 'artists', 'description', 'url']);
  while (widths.reduce((a, b) => a + b, 0) + (columns.length - 1) * 2 > (options.width ?? 80)) {
    const index = widths.reduce((best, width, i) => flexible.has(columns[i]!) && width > 1 && (best < 0 || width > widths[best]!) ? i : best, -1);
    if (index < 0) break; widths[index]!--;
  }
  const line = (row: string[]): string => row.map((value, i) => { const chars = [...value], width = widths[i]!; const cell = chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : value; return cell + ' '.repeat(Math.max(0, width - [...cell].length)); }).join('  ').trimEnd();
  const header = line(columns);
  return `${options.noColor ? header : `\u001b[1m${header}\u001b[0m`}\n${rows.map(line).join('\n')}${rows.length ? '\n' : ''}`;
}
export function render(result: unknown, columns: string[], rows: unknown[][], quiet: string[], options: OutputOptions, sentence?: string): string {
  const mode = outputMode(options);
  if (mode === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  if (mode === 'quiet') return quiet.length ? quiet.join('\n') + '\n' : '';
  if (mode === 'table' && sentence) return sentence + '\n';
  if (!rows.length) return '';
  return table(columns, rows, options);
}
