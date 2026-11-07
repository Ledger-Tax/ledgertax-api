/** How a column's values are treated. */
export type ColumnKind = 'text' | 'number';

/** One CSV column. */
export interface Column<T> {
  header: string;
  /**
   * `text` values may contain anything (memos, asset codes, labels come from outside) and are
   * neutralised and quoted. `number` values are produced by this program and must look like a
   * plain (possibly negative) decimal, or be empty; they are never altered.
   */
  kind: ColumnKind;
  value: (row: T) => string;
}

/** The disclaimer that starts every report. */
export const DISCLAIMER = 'Accounting export, not tax advice.';

/**
 * Neutralises spreadsheet formula injection: text whose first character (ignoring leading spaces)
 * is `=`, `+`, `-`, `@`, a tab, a carriage return, a line feed, or a full-width `＝ ＋ － ＠`
 * would be run as a formula by Excel, LibreOffice and Google Sheets. A single quote is put in front,
 * which spreadsheets show as plain text.
 */
export function neutralize(text: string): string {
  return /^[=+\-@\t\r\n＝＋－＠]/.test(text.replace(/^ +/, '')) ? `'${text}` : text;
}

/** Quotes a field if it contains a comma, a double quote or a line break (RFC 4180). */
function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A text cell: neutralised, then quoted if needed. */
export function csvText(text: string): string {
  return quote(neutralize(text));
}

/** A number cell: only digits with an optional minus sign and decimal part, or empty. */
export function csvNumber(text: string): string {
  if (text !== '' && !/^-?\d+(\.\d+)?$/.test(text)) {
    throw new TypeError('A number column received a value that is not a plain decimal.');
  }
  return text;
}

/** One comment line: starts with `# `, never contains a line break. */
export function csvComment(text: string): string {
  return `# ${text.replace(/[\r\n]+/g, ' ')}`;
}

/**
 * Writes a CSV file: comment lines first (each beginning with `# `), then the header, then the
 * rows. Lines end with `\n`. Readers should skip lines that start with `#`.
 *
 * @param columns - column definitions
 * @param rows - the data
 * @param comments - lines for the top of the file, without the `# ` prefix
 */
export function writeCsv<T>(
  columns: readonly Column<T>[],
  rows: Iterable<T>,
  comments: readonly string[],
): string {
  const lines = comments.map(csvComment);
  lines.push(columns.map((c) => csvText(c.header)).join(','));
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => (c.kind === 'number' ? csvNumber(c.value(row)) : csvText(c.value(row))))
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
