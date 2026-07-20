# Testing and Verification

Codex must verify changes according to the affected area.

---

## Pricing / Discount Changes

Check:

- Normal item price
- Manual rate change
- Discount percentage
- Discount amount
- Pricing Rule
- Customer price list
- POS Profile price list
- POS Profile currency
- POS Profile company
- UOM conversion
- Multi-currency if applicable
- Invoice total
- Print total
- Backend Sales Invoice payload

---

## Cart Changes

Check:

- Add item
- Remove item
- Update quantity
- Change UOM
- Change rate
- Apply discount
- POS Profile warehouse
- POS Profile customer
- POS Profile company
- Large cart performance
- Payment screen total
- Sales Invoice payload
- Offline cart behavior

---

## Offline Changes

Check:

- Fresh cache
- Existing old cache
- Missing cache fields
- Sync after reconnect
- New build update behavior
- App reload behavior
- IndexedDB compatibility
- POS Profile configuration changes
- POS Profile-dependent cache scope
- Invoice outbox runs before a deliberately slow catalog resource
- Overlapping reconnect, timer, server-online, and manual triggers remain
  single-flight without dropping a later trigger
- Legacy-only invoices migrate or drain, while a row also owned by the outbox is
  never submitted through the legacy endpoint
- Ambiguous legacy exceptions never enter draft fallback; only a structured,
  non-retryable Frappe 4xx rejection may use that compatibility path
- Outbox retry, backoff, acknowledgement, and dead-letter transitions preserve
  one client request ID
- Missing, draft, contradictory, mismatched-request, and unsupported-document
  responses remain unresolved; only a named submitted Sales/POS Invoice with a
  matching request ID is acknowledged
- Sales Orders and Quotations never enter invoice journal, outbox, migration,
  replay, or legacy invoice endpoints after an ambiguous response
- Reload recovers a synchronous intent journal and keeps the sale locked until
  authoritative acknowledgement or supervisor review
- Recovery remains locked when the authenticated user, POS Profile, company, or
  document type is missing or differs from the durable pointer
- Ambiguous accepted responses do not restore payment or enable Submit again
- Payment dialog close, route/remount, keyboard, mobile layout, print, and cart
  clearing paths cannot bypass an active recovery lock
- Mobile inline and Alt+X/Alt+P shortcut submission retain the exact Payments
  owner through cashier signing, resize, dispatch, and recovery; ownerless
  startup recovery opens a visible persistent dialog
- A deferred live request locks Cancel, Escape/scrim, shortcuts, navigation,
  payment inputs, and cart edits before its response arrives
- A matching or empty restored cart may settle; a non-empty cart with another
  request ID remains byte-for-byte unchanged and manually locked
- Acknowledgement updates last-invoice and local stock once and retains the
  terminal outbox audit row
- Failed acknowledgement-journal cleanup remains visible, retains the terminal
  row, and retries cleanup without resubmitting the sale
- Direct and reconciled acknowledgements require exact request ID, invoice name,
  supported invoice doctype, and explicit submitted/queued status; malformed or
  fallback identities remain unresolved
- Browser observation events and client callbacks cannot turn an acknowledged
  mutation into a retryable checkout failure
- Unstructured direct HTTP 400/409 outcomes retain the recovery pointer,
  journal, outbox row, and checkout lock; explicit validation/business envelopes
  remain definite failures
- Supervisor resolution enforces the canonical POS scope, typed request ID,
  non-empty reason, supported document/outcome pair, submitted-document proof,
  rejection of any supposedly-not-submitted existing document, and idempotent
  immutable audit evidence
- Offline delete/clear removes only the exact unresolved journal/outbox/legacy
  ownership set and refuses syncing or acknowledged commands
- Direct acknowledgement racing a coordinator claim leaves one retained
  acknowledged row; stale success/failure completion cannot regress or delete it
- Definite-failure cleanup removes only the exact immutable pending intent and
  refuses a row that advanced to syncing or acknowledged
- Single-tab recovery is deterministic; concurrent POS tabs remain unsupported
  until a tab lease and BroadcastChannel/storage-event tests are implemented

---

## Printing Changes

Check:

- Browser print
- QZ Tray print
- Item rates
- Discounts
- Taxes
- Payment method
- Grand total
- UOM display
- Customer display
- POS Profile print format
- POS Profile letter head

---

## Customer Changes

Check:

- Default customer
- Newly added customer
- Customer-specific price list
- POS Profile fallback price list
- POS Profile default customer
- POS Profile customer filters
- Offline customer data
- Invoice payload customer field
- Printed customer details

---

## POS Profile Changes / POS Profile Dependent Features

Check:

- Correct POS Profile is loaded
- Company comes from POS Profile
- Warehouse comes from POS Profile
- Price List comes from POS Profile when customer-specific price list is not set
- Customer-specific price list priority still works
- Currency is handled correctly
- Taxes and Charges are applied correctly
- Payment Methods match POS Profile configuration
- Sales Invoice payload uses correct POS Profile defaults
- Print format respects POS Profile settings where applicable
- Offline cache loads POS Profile-dependent data correctly
- App does not crash if optional POS Profile fields are missing
- Custom POS Profile fields are not ignored when relevant

---

## UOM Changes

Check:

- Default UOM
- Alternate UOM
- Barcode UOM
- Conversion factor
- Stock quantity
- Item rate
- Discount
- Invoice payload
- Print receipt

---

## Required Final Verification Format

After changes, report:

```md
## Summary
...

## Files Changed
- `path/to/file`: reason

## Linked Features Checked
- ...

## Commands Run
- ...

## Risks / Notes
- ...
```
