# ADR 0002 — Money in integer paise; instants in UTC, business dates in IST

**Status:** Accepted (2026-06) · **Deciders:** maintainer

## Context

The product promise is "reports are never argued with". Two things break that
promise silently: floating-point rupees (₹0.01 drift across thousands of
EMIs) and timezone math (a call at 11:55 PM counting for tomorrow because the
host laptop is set to UTC). Indian teams read amounts as ₹ lakh/crore and days
as IST calendar days.

## Decision

1. **Every amount is an integer number of paise** in the database, the API and
   the client state. Rupees exist only at the display edge (`₹1,23,456.78`) and
   at input parsing. Sums are integer sums; `Number.isSafeInteger` is asserted
   and a single upper bound (`MAX_PAISE`, ₹100 crore) is enforced on every money
   route so a poisoned value cannot corrupt rollups.
2. **Instants** (when something happened) are stored as UTC ISO-8601 strings.
   **Business dates** (which day a call/target/follow-up belongs to) are IST
   `YYYY-MM-DD` strings. All conversions go through `server/lib/istTime.js`
   (IST = UTC+05:30, no DST); SQL never uses `date('now')` for business logic —
   the server passes UTC bounds computed from the IST day.
3. **Pending = deal value − payments received**, never derived from installment
   statuses; installment `due_paise` is computed from linked and FIFO-applied
   payments.

## Consequences

- Reports are reproducible on any machine regardless of its clock zone; tests
  pin IST boundaries explicitly.
- Non-Indian deployments would need a timezone setting — deliberately not built.
- Client code must never do `amount / 100` arithmetic for logic, only for
  formatting; reviewers check for `parseFloat` on money fields.
- Schema comments and column names use `_paise` and `_at` (UTC) / `_date` (IST)
  suffixes so the type is visible at the call site.
