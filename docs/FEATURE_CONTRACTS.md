# Feature Contracts

This file defines how major POS features are connected.

Codex must check this file before changing any related feature.

---

## 1. Pricing Contract

Pricing is linked with:

- Item master
- Item price
- Customer price list
- POS Profile price list
- POS Profile currency
- POS Profile company
- Pricing Rule
- UOM conversion
- Manual rate change
- Discount percentage
- Discount amount
- Tax calculation
- Cart total
- Payment total
- Sales Invoice payload
- Print receipt
- Offline cache

Rules:

- Price must be resolved from one shared pricing flow.
- Manual rate should not be overwritten unless ERPNext behavior requires it.
- Customer price list should take priority over POS Profile price list when configured.
- Pricing changes must check POS Profile price list and customer-specific price list priority.
- UOM conversion must not inflate or deflate prices incorrectly.
- Multi-currency conversion must be handled consistently.
- Discount percentage and discount amount must not fight each other.
- Cart totals, payment totals, invoice payload, and printed totals must match.

---

## 2. Discount Contract

Discount is linked with:

- Item row
- Cart summary
- Invoice total
- Additional discount
- Payment screen
- Print receipt
- Backend invoice payload

Rules:

- Discount percentage and discount amount must remain synchronized.
- Changing one discount field must not reset item rate incorrectly.
- Zero rate should not be created unless explicitly allowed.
- Total discount must match printed and submitted invoice values.
- Discount logic should not be duplicated across screens.

---

## 3. Cart Contract

Cart is linked with:

- Item search
- Barcode scan
- UOM selection
- POS Profile warehouse
- POS Profile customer
- POS Profile company
- Batch/serial logic
- Stock validation
- Pricing
- Discounts
- Taxes
- Payments
- Offline storage
- Sales Invoice creation
- Printing

Rules:

- Cart state is the source for visible cart data.
- Derived totals must be calculated consistently.
- Avoid separate total calculation logic in multiple screens.
- Cart should survive offline/online transitions safely.
- Large carts must remain performant.
- Cart defaults must respect POS Profile configuration.

---

## 4. Offline Cache Contract

Offline cache is linked with:

- Items
- Prices
- Customers
- Stock
- POS Profile
- POS Profile configuration
- Cart
- Sales Invoice sync
- Printing
- App version updates

Rules:

- Cached data shape must match API data shape as much as possible.
- Missing or stale cache must not crash the app.
- New build/version changes must not leave old IndexedDB data in a broken state.
- Sync transformations must be backward compatible where possible.
- Offline mode must use the same business rules as online mode wherever possible.
- Offline cache must refresh safely when POS Profile configuration changes.
- Offline pricing data must not depend on a record having been used online
  previously.
- Item Prices must preserve price list, UOM, currency, customer, and validity.
- Pricing Rule sync must include customer/group rules before a customer is
  selected offline.
- Multi-currency sync must cover price-list, invoice, company, and payment
  account currencies, including dated Currency Exchange records.
- Disabled, deleted, or out-of-scope pricing records must be removed locally.

---

## 5. Printing Contract

Printing is linked with:

- Cart data
- Invoice data
- Customer
- Taxes
- Discounts
- UOM
- Payment methods
- QZ Tray
- Browser print
- ERPNext print format
- POS Profile print format
- POS Profile letter head

Rules:

- Printed totals must match submitted invoice totals.
- QZ Tray and browser print should use the same final invoice values.
- Receipt formatting changes must not change business calculations.
- Print output should not calculate totals differently from the invoice payload.
- Print settings should respect POS Profile configuration where applicable.

---

## 6. Customer Contract

Customer selection is linked with:

- Customer price list
- Credit limit/outstanding balance if implemented
- Cart pricing refresh
- Taxes
- Discounts
- Sales Invoice payload
- Payment screen
- Print receipt
- Offline customer cache

Rules:

- Customer change must refresh all dependent pricing/tax fields safely.
- Customer-specific price list must be respected.
- Offline customer data must not crash pricing logic if optional fields are missing.

---

## 7. UOM Contract

UOM is linked with:

- Item master
- Barcode
- Price list
- Conversion factor
- Stock quantity
- Rate
- Discount
- Cart total
- Sales Invoice payload
- Print receipt

Rules:

- UOM conversion must be applied consistently.
- Rate must not be inflated because of wrong conversion direction.
- Quantity, stock, and invoice payload must use compatible UOM data.

---

## 8. POS Profile Contract

POS Profile is linked with:

- Company
- Warehouse
- Cost Center
- Customer
- Customer price list fallback
- POS Profile price list
- Currency
- Taxes and Charges
- Payment Methods
- Write Off Account
- Change Amount Account
- Stock validation
- Item filtering
- Customer filtering
- Offline cache
- Sync logic
- Sales Invoice payload
- Print format
- QZ Tray receipt
- POS opening and closing

Rules:

- POS Profile must be checked before changing any POS behavior.
- Do not hardcode company, warehouse, price list, payment method, tax, or print behavior.
- Customer-specific price list should take priority when configured, then POS Profile price list should be used as fallback.
- Stock, warehouse, and invoice payload must respect POS Profile configuration.
- Payment screen must respect payment methods configured in POS Profile.
- Print and receipt logic must respect POS Profile print settings where applicable.
- Offline cache must load and store POS Profile-dependent data safely.
- Custom POS Profile fields must be considered when present.

---

## 9. Sale Submission Recovery Contract

Sale submission recovery is linked with:

- Payment submission and cashier signing
- Immutable client request identity
- Synchronous intent journal
- IndexedDB invoice outbox
- Legacy write-queue compatibility
- Reconnect, timer, and manual sync triggers
- Local stock projection
- Last-invoice state and printing

Rules:

- Persist the immutable invoice sale intent and client request ID before
  dispatching an automatically recoverable request. Persist a manual-review
  lock before dispatching any other supported POS document.
- Automatic replay is limited to explicit `Sales Invoice` and `POS Invoice`
  payloads. Sales Orders, Quotations, missing document types, and contradictory
  identities must fail closed for supervisor review and must never be coerced
  through an invoice endpoint.
- A timeout, abort, transport failure, server failure, retryable or unstructured
  HTTP failure, or missing response after dispatch is an ambiguous outcome, not
  proof that the sale failed. Only an explicit, structured, non-retryable Frappe
  4xx rejection may use the legacy draft-compatibility path.
- Treat a response as final only when it explicitly proves submission, or as
  queued only when it explicitly carries the queued flag and draft status. A
  browser event, invoice name, or otherwise truthy response is not an
  acknowledgement.
- Keep an ambiguous sale visibly locked in confirmation state. Do not restore
  its payment attempt or allow a fresh submission with a different identity.
- Enter one shared checkout mutation lock before dispatch and keep it through
  direct completion or recovery. Submit, cancel, dialog close, keyboard,
  navigation, cart editing, cart clearing, and mobile remount paths must all
  honor that same lock.
- Freeze the active Payments host (dialog, inline/mobile, or shortcut) before
  locking so cashier signing, submission, and recovery keep one live owner.
  Responsive changes must not replace that owner; ownerless startup recovery
  must fall back to a visible persistent dialog.
- Bind the durable recovery pointer to the authenticated user, POS Profile,
  company, and document type. A missing or mismatched scope must fail closed
  before local lookup, replay, settlement, or client-side effects.
- Before any recovered acknowledgement changes UI state, require a non-empty
  current cart to carry the same immutable request ID. A different cart must
  remain untouched and the recovery must stay locked for manual review.
- Process transactional invoice recovery before boot-critical, warm catalog, or
  lazy sync resources, and keep all production triggers on one configured,
  single-flight coordinator.
- The invoice outbox is authoritative for every request ID it contains. A
  matching legacy write-queue row is compatibility data and must never become a
  second claim path; legacy-only rows must still drain during upgrades.
- Outbox state changes are monotonic and compare-and-set against the exact
  payload and sync claim. A direct acknowledgement may finalize an in-flight
  row, but stale coordinator completion may never overwrite or delete that
  terminal evidence. Definite-failure cleanup may delete only an exact pending,
  unsent row.
- On acknowledgement, retain the terminal outbox record for audit/pruning,
  strictly verify removal of the synchronous intent journal, and update
  last-invoice, stock, print, and navigation state exactly once. Journal cleanup
  failure must remain visible and retry cleanup without resubmitting the sale.
- Direct submission and recovery responses must repeat the exact request ID,
  invoice name, supported invoice doctype, and an explicit submitted or queued
  state. Browser events and callback failures cannot downgrade a proven
  acknowledgement into a retryable checkout failure.
- A post-dispatch `HTTP_ERROR`, including an unstructured HTTP 400 or 409, is
  ambiguous regardless of its retryable flag. Only an explicit structured
  validation or business-rule envelope is a definite direct rejection.
- Legacy compatibility responses obey the same exact request/type/status rule.
  A returned but invalid acknowledgement remains unresolved and must not be
  converted into a successful draft fallback.
- A dead-letter sale stays locked for supervisor status reconciliation. It must
  not silently become a new sale.
- Manual resolution requires an authenticated supervisor for the pointer's POS
  scope, an exact typed request ID, a non-empty note, and one explicit outcome.
  `submitted` must be verified against a submitted same-company document;
  `not_submitted` must reject every supplied document that still exists. Keep
  the resulting audit evidence immutable and make repeated identical decisions
  idempotent.
- Deleting an unresolved offline sale must remove its journal, outbox command,
  and compatibility row as one guarded operation. A syncing or acknowledged
  command cannot be deleted as if it were unsent.
- This release supports one active POS tab per browser/terminal. Concurrent-tab
  ownership, lease expiry, and browser-signal propagation require a future
  cross-tab coordination contract before multi-tab checkout is supported.
