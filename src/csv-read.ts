import { CsvSyntaxError } from './errors.js';

/** One CSV record and the 1-based physical line it starts on. */
export interface CsvRecord {
  line: number;
  fields: string[];
}

/**
 * Parses RFC 4180 style CSV: comma separated, fields may be double-quoted, quotes inside a quoted
 * field are doubled, a quoted field may contain commas and line breaks. Both `\n` and `\r\n` end a
 * record. Blank lines are skipped. A leading byte-order mark is ignored.
 *
 * @throws CsvSyntaxError for an unterminated quote or text after a closing quote
 */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let quoteLine = 1;
  let afterQuote = false;
  let started = false;

  const endField = (): void => {
    fields.push(field);
    field = '';
    afterQuote = false;
  };
  const endRecord = (): void => {
    if (started || fields.length > 0 || field !== '') {
      endField();
      if (!(fields.length === 1 && fields[0] === '')) records.push({ line: recordLine, fields });
    }
    fields = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field !== '' || afterQuote) throw new CsvSyntaxError(line, 'unexpected quote in a field');
      inQuotes = true;
      quoteLine = line;
      started = true;
      continue;
    }
    if (afterQuote && ch !== ',' && ch !== '\n' && ch !== '\r') {
      throw new CsvSyntaxError(line, 'text after a closing quote');
    }
    if (ch === ',') {
      started = true;
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      started = true;
      field += ch;
    }
  }
  if (inQuotes) throw new CsvSyntaxError(quoteLine, 'a quoted field is never closed');
  endRecord();
  return records;
}
