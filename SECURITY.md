# Security policy

Accounting export, not tax advice.

## The read-only guarantee

ledgertax-api only reads public data. It never holds, asks for, stores or logs a secret key or seed phrase, and it never signs or submits a transaction. Input shaped like a Stellar secret key (56 characters starting with `S`) is rejected and never echoed.

## What to report

- Any way to make the software accept, store, log or send a secret key.
- Any way to cause a transaction to be signed or submitted.
- Spreadsheet formula injection that gets past the CSV writers (an exported cell that a spreadsheet would run as a formula).
- Leaks of user-supplied labels, prices or addresses beyond what the README says.
- Remote code execution, denial of service from small requests, or path traversal.

## How to report

Please **do not open a public issue** for a vulnerability. Use the repository's private vulnerability reporting (the "Report a vulnerability" button under the Security tab) if it is enabled.

If that button is not available, email **chrisjacobs2468@gmail.com** with a subject starting "Security: ledgertax-api".

Please include what you did, what you expected and what happened. Use testnet data only.

## Supported versions

The project is early and has no released versions yet. Fixes go to the main branch.
