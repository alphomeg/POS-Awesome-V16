"""Custom POS Invoice class that integrates POS Awesome shift logic."""

from erpnext.accounts.doctype.pos_invoice.pos_invoice import POSInvoice as ERPNextPOSInvoice
from frappe.utils import cint

from posawesome.posawesome.api.credit_sales import is_trusted_credit_sale
from posawesome.posawesome.api.invoice import validate_shift


class CustomPOSInvoice(ERPNextPOSInvoice):
    """Override ERPNext POS Invoice to respect POS Awesome opening shifts."""

    def validate_pos_opening_entry(self):
        """Allow POS invoices when a POS Awesome shift is open.

        If the invoice references ``posa_pos_opening_shift`` we validate that
        shift using POS Awesome's rules and skip the standard ERPNext
        validation for ``POS Opening Entry``. Otherwise, fall back to the
        default ERPNext behaviour.
        """

        if getattr(self, "posa_pos_opening_shift", None):
            # Use existing shift validation from POS Awesome
            validate_shift(self)
            return

        # No POS Awesome shift - use ERPNext's validation
        super().validate_pos_opening_entry()

    def validate_stock_availablility(self):
        """Keep normal POS stock controls, except for importer-owned history.

        RetailMind's old-POS importer posts historical POS Invoices with
        ``update_stock=0`` because current inventory is established separately by
        the deterministic opening Stock Reconciliation. ERPNext validates every
        POS Invoice against today's on-hand quantity even when it has no stock
        impact, which incorrectly rejects legitimate historical lines such as
        zero-balance service or delivery-charge items. The import-run marker keeps
        this exception tightly scoped: live POS invoices continue to use ERPNext's
        normal warehouse stock validation.
        """

        if getattr(self, "retailmind_legacy_import_run", None) and not cint(
            getattr(self, "update_stock", 0)
        ):
            return

        return super().validate_stock_availablility()

    def validate_mode_of_payment(self):
        if is_trusted_credit_sale(self):
            return
        super().validate_mode_of_payment()

    def validate_full_payment(self):
        if is_trusted_credit_sale(self):
            return
        super().validate_full_payment()

    def validate_pos_paid_amount(self):
        if is_trusted_credit_sale(self):
            return
        super().validate_pos_paid_amount()
