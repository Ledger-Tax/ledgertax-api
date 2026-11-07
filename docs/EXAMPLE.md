# Worked example (calculated by hand)

Accounting export, not tax advice.

This example is the hand-calculated reference for the FIFO tests in `test/costbasis.test.ts`. The numbers were worked out on paper from the rules in `src/costbasis.ts`, not copied from program output. Currency: USD. All times are `00:00:00Z`. `ISSUER` below stands for a made-up issuer of the asset `TEST`.

## Prices (`prices.csv`)

| asset | date       | price |
| ----- | ---------- | ----- |
| XLM   | 2025-01-01 | 0.10  |
| XLM   | 2025-01-15 | 0.12  |
| TEST  | 2025-02-01 | 1.00  |
| XLM   | 2025-03-01 | 0.15  |
| XLM   | 2025-03-02 | 0.15  |
| XLM   | 2025-03-10 | 0.15  |
| XLM   | 2025-03-11 | 0     |
| XLM   | 2025-03-12 | 0.20  |

## Events (in order) and what FIFO does

| #   | Date       | Event                            | Label    | Result                                                                                                                                                                                                   |
| --- | ---------- | -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e1  | 2025-01-01 | receive 100 XLM                  | income   | Lot A: 100 XLM, cost 100 x 0.10 = **10.00**                                                                                                                                                              |
| e2  | 2025-01-15 | receive 50 XLM                   | income   | Lot B: 50 XLM, cost 50 x 0.12 = **6.00**                                                                                                                                                                 |
| e3  | 2025-02-01 | trade: sell 120 XLM, get 30 TEST | (none)   | Value = 30 TEST x 1.00 = **30.00**. FIFO takes all of lot A (100) and 20 of lot B. Proceeds split by quantity: 30.00 x 100/120 = **25.00** and 30.00 x 20/120 = **5.00**. New lot C: 30 TEST, cost 30.00 |
| e4  | 2025-03-01 | send 30 XLM                      | disposal | Price 0.15, proceeds 30 x 0.15 = **4.50**. Takes the 30 XLM left of lot B                                                                                                                                |
| e5  | 2025-03-02 | send 10 XLM                      | disposal | Price 0.15, proceeds 1.50. No XLM lots are left: **error row, 10 XLM not covered**                                                                                                                       |
| e6  | 2025-03-10 | trade: sell 10 TEST, get 50 XLM  | (none)   | Value = 50 XLM x 0.15 = **7.50**. Takes 10 of lot C (cost 30.00 x 10/30 = **10.00**). New lot D: 50 XLM, cost 7.50                                                                                       |
| e7  | 2025-03-11 | receive 5 XLM                    | income   | Price 0, so lot E: 5 XLM, cost **0.00** (a zero-cost lot)                                                                                                                                                |
| e8  | 2025-03-12 | send 52 XLM                      | disposal | Price 0.20, proceeds 52 x 0.20 = **10.40**. Takes 50 of lot D, then 2 of lot E. Proceeds split: 10.40 x 50/52 = **10.00** and 10.40 x 2/52 = **0.40**. Cost of 2 of lot E = 0.00 x 2/5 = 0.00            |

## Expected `gains` rows

| Disposal | Lot consumed | Quantity | Proceeds | Cost  | Gain       | Holding days         |
| -------- | ------------ | -------- | -------- | ----- | ---------- | -------------------- |
| e3       | A (e1)       | 100 XLM  | 25.00    | 10.00 | **+15.00** | 31 (Jan 1 to Feb 1)  |
| e3       | B (e2)       | 20 XLM   | 5.00     | 2.40  | **+2.60**  | 17 (Jan 15 to Feb 1) |
| e4       | B (e2)       | 30 XLM   | 4.50     | 3.60  | **+0.90**  | 45 (Jan 15 to Mar 1) |
| e6       | C (e3)       | 10 TEST  | 7.50     | 10.00 | **-2.50**  | 37 (Feb 1 to Mar 10) |
| e8       | D (e6)       | 50 XLM   | 10.00    | 7.50  | **+2.50**  | 2 (Mar 10 to Mar 12) |
| e8       | E (e7)       | 2 XLM    | 0.40     | 0.00  | **+0.40**  | 1 (Mar 11 to Mar 12) |

Cost of the 20 XLM taken from lot B in e3: 6.00 x 20/50 = 2.40; what is left of lot B costs 6.00 - 2.40 = 3.60, which is exactly what e4 uses (no rounding drift).

## Expected problems (not guesses)

| Event | Problem             | Detail             |
| ----- | ------------------- | ------------------ |
| e5    | `insufficient_lots` | 10 XLM not covered |

Totals: gains +15.00 +2.60 +0.90 -2.50 +2.50 +0.40 = **+18.90**.

## Missing-price cases (tested separately)

- A `disposal` with no price for its day gives a `missing_price` row; the lots are still used up so later rows stay consistent.
- A trade with no price for either asset on its day gives a `missing_price` row. If only the sold asset has a price, the trade is valued with it.
- An incoming payment with no `income` label has an unknown cost; disposing of it gives an `unknown_cost_basis` row.
