import { LedgerTaxError } from '@veronicdev/ledgertax-core';

/** The text is not valid CSV (for example an unterminated quote). */
export class CsvSyntaxError extends LedgerTaxError {
  /** 1-based line where the problem starts. */
  readonly line: number;

  constructor(line: number, detail: string) {
    super('csv_syntax', `CSV syntax error at line ${line}: ${detail}`);
    this.line = line;
  }
}

/** A price file is over the allowed size or row count. */
export class PriceCsvTooLargeError extends LedgerTaxError {
  constructor(detail: string) {
    super('price_csv_too_large', `The price file is too large: ${detail}`);
  }
}

/** A price file has a bad header or bad rows. `issues` lists them with row numbers. */
export class PriceCsvError extends LedgerTaxError {
  readonly issues: readonly PriceCsvIssue[];

  constructor(issues: readonly PriceCsvIssue[]) {
    super('invalid_price_csv', `The price file has ${issues.length} problem(s).`);
    this.issues = issues;
  }
}

/** One problem found in a price file. */
export interface PriceCsvIssue {
  /** 1-based line number in the file (the header is line 1). 0 for whole-file problems. */
  row: number;
  /** Column name, when the problem belongs to one column. */
  column?: string;
  message: string;
}

/** The history is longer than this server is willing to process in one request. */
export class HistoryTooLargeError extends LedgerTaxError {
  readonly limit: number;

  constructor(limit: number) {
    super(
      'history_too_large',
      `This address has more than ${limit} events in range. Narrow the range with "since".`,
    );
    this.limit = limit;
  }
}
