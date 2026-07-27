import importlib.util
import pathlib
import sys
import types
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
OVERRIDE_PATH = REPO_ROOT / "posawesome" / "posawesome" / "overrides" / "pos_invoice.py"


def _load_override_module():
	frappe_utils = types.ModuleType("frappe.utils")
	frappe_utils.cint = lambda value: int(bool(value))

	erpnext_module = types.ModuleType("erpnext")
	erpnext_accounts_module = types.ModuleType("erpnext.accounts")
	erpnext_doctype_module = types.ModuleType("erpnext.accounts.doctype")
	erpnext_pos_module = types.ModuleType("erpnext.accounts.doctype.pos_invoice")
	erpnext_pos_invoice_module = types.ModuleType("erpnext.accounts.doctype.pos_invoice.pos_invoice")
	credit_sales_module = types.ModuleType("posawesome.posawesome.api.credit_sales")
	invoice_module = types.ModuleType("posawesome.posawesome.api.invoice")

	class ERPNextPOSInvoice:
		def validate_stock_availablility(self):
			self.base_stock_validation_calls = getattr(self, "base_stock_validation_calls", 0) + 1

	erpnext_pos_invoice_module.POSInvoice = ERPNextPOSInvoice
	credit_sales_module.is_trusted_credit_sale = lambda doc: False
	invoice_module.validate_shift = lambda doc: None

	sys.modules["frappe.utils"] = frappe_utils
	sys.modules["erpnext"] = erpnext_module
	sys.modules["erpnext.accounts"] = erpnext_accounts_module
	sys.modules["erpnext.accounts.doctype"] = erpnext_doctype_module
	sys.modules["erpnext.accounts.doctype.pos_invoice"] = erpnext_pos_module
	sys.modules["erpnext.accounts.doctype.pos_invoice.pos_invoice"] = erpnext_pos_invoice_module
	sys.modules["posawesome.posawesome.api.credit_sales"] = credit_sales_module
	sys.modules["posawesome.posawesome.api.invoice"] = invoice_module

	module_name = "posawesome.posawesome.overrides.pos_invoice"
	spec = importlib.util.spec_from_file_location(module_name, OVERRIDE_PATH)
	module = importlib.util.module_from_spec(spec)
	sys.modules[module_name] = module
	spec.loader.exec_module(module)
	return module


class TestCustomPOSInvoice(unittest.TestCase):
	def test_legacy_non_stock_pos_invoice_skips_erpnext_stock_validation(self):
		override = _load_override_module()
		doc = object.__new__(override.CustomPOSInvoice)
		doc.retailmind_legacy_import_run = "OLDPOS-RUN-1"
		doc.update_stock = 0

		doc.validate_stock_availablility()

		self.assertEqual(getattr(doc, "base_stock_validation_calls", 0), 0)

	def test_live_or_stock_updating_pos_invoice_keeps_erpnext_stock_validation(self):
		override = _load_override_module()
		for import_run, update_stock in ((None, 0), ("OLDPOS-RUN-1", 1)):
			doc = object.__new__(override.CustomPOSInvoice)
			doc.retailmind_legacy_import_run = import_run
			doc.update_stock = update_stock

			doc.validate_stock_availablility()

			self.assertEqual(doc.base_stock_validation_calls, 1)


if __name__ == "__main__":
	unittest.main()
