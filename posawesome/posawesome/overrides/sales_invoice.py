"""Sales Invoice validation extensions for authoritative POS credit sales."""

from erpnext.accounts.doctype.sales_invoice.sales_invoice import (
    SalesInvoice as ERPNextSalesInvoice,
)

from posawesome.posawesome.api.credit_sales import is_trusted_credit_sale


class CustomSalesInvoice(ERPNextSalesInvoice):
    """Preserve native behavior except for a server-authorized POS credit sale."""

    def validate_full_payment(self):
        if is_trusted_credit_sale(self):
            return
        super().validate_full_payment()

    def validate_pos_paid_amount(self):
        if is_trusted_credit_sale(self):
            return
        super().validate_pos_paid_amount()
