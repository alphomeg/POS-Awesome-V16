import importlib.util
import pathlib
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone


REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_ORIGINAL_MODULES = dict(sys.modules)


def _install_stubs():
	frappe_module = types.ModuleType("frappe")
	frappe_module._ = lambda text: text
	frappe_module.PermissionError = PermissionError
	frappe_module.local = types.SimpleNamespace(
		conf={"encryption_key": "test-site-secret"},
	)
	frappe_module.conf = {"encryption_key": "test-site-secret"}
	def get_cached_value(doctype, name, fieldname):
		if (doctype, name, fieldname) == ("Mode of Payment", "Cash", "type"):
			return "Cash"
		if (doctype, name, fieldname) == (
			"Company",
			"RetailMind",
			"default_currency",
		):
			return "PKR"
		return None

	frappe_module.get_cached_value = get_cached_value
	frappe_module.throw = lambda message, exception=None: (_ for _ in ()).throw(
		(exception or Exception)(message)
	)
	frappe_module.whitelist = lambda *args, **kwargs: (lambda fn: fn)
	sys.modules["frappe"] = frappe_module

	security = types.ModuleType("posawesome.posawesome.api.cashier_pin_security")
	security.redact_cashier_pin_request_context = lambda: None
	sys.modules[security.__name__] = security

	profile = {
		"name": "Main POS",
		"company": "RetailMind",
		"posa_allow_offline_signed_cash_sales": 1,
		"posa_cash_mode_of_payment": "Cash",
		"posa_offline_signed_sale_max_amount": "10000",
		"posa_offline_signed_sale_ttl_minutes": 60,
		"posa_offline_signed_sale_ticket_batch_size": 3,
		"modified": "2026-08-01 12:00:00",
		"payments": [{"mode_of_payment": "Cash"}],
	}
	pos_access = types.ModuleType("posawesome.posawesome.api.pos_access")
	pos_access.current_user = "cashier@example.com"
	pos_access.get_authenticated_pos_user = lambda: pos_access.current_user
	pos_access.user_can_manage_pos = lambda user: user == "supervisor@example.com"
	pos_access.get_authorized_pos_profile = lambda _profile=None: dict(profile)
	pos_access.profile = profile
	sys.modules[pos_access.__name__] = pos_access

	terminal = types.ModuleType("posawesome.posawesome.api.terminal_state")
	def validate(profile_name, cashier):
		if profile_name != "Main POS" or cashier not in {
			"cashier@example.com",
			"supervisor@example.com",
		}:
			raise PermissionError("Cashier is not assigned")
		return cashier
	terminal.validate_assigned_terminal_cashier = validate
	sys.modules[terminal.__name__] = terminal

	employees = types.ModuleType("posawesome.posawesome.api.employees")
	def resolve_cashier_by_pin(pos_profile=None, pin=None):
		if pin == "2468":
			return {"user": "cashier@example.com"}
		if pin == "9999":
			return {"user": "supervisor@example.com", "is_supervisor": True}
		raise ValueError("Invalid cashier PIN")

	employees.resolve_cashier_by_pin = resolve_cashier_by_pin
	sys.modules[employees.__name__] = employees
	return {
		"profile": profile,
		"pos_access": pos_access,
		"terminal": terminal,
		"employees": employees,
	}


def _load_module():
	module_name = "posawesome.posawesome.api.offline_sale_authorizations"
	file_path = REPO_ROOT / "posawesome" / "posawesome" / "api" / "offline_sale_authorizations.py"
	spec = importlib.util.spec_from_file_location(module_name, file_path)
	module = importlib.util.module_from_spec(spec)
	sys.modules[module_name] = module
	spec.loader.exec_module(module)
	return module


class TestOfflineSaleAuthorizations(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.stubs = _install_stubs()
		cls.profile = cls.stubs["profile"]
		cls.module = _load_module()
		# Keep the module function as a static descriptor; assigning it through an
		# instance would otherwise bind ``self`` on the next test.
		cls._original_utcnow = staticmethod(cls.module._utcnow)

	@classmethod
	def tearDownClass(cls):
		for name in list(sys.modules):
			if name.startswith(("frappe", "posawesome")) and name not in _ORIGINAL_MODULES:
				sys.modules.pop(name, None)
		for name, module in _ORIGINAL_MODULES.items():
			if name.startswith(("frappe", "posawesome")):
				sys.modules[name] = module

	def setUp(self):
		def get_cached_value(doctype, name, fieldname):
			if (doctype, name, fieldname) == ("Mode of Payment", "Cash", "type"):
				return "Cash"
			if (doctype, name, fieldname) == (
				"Company",
				"RetailMind",
				"default_currency",
			):
				return "PKR"
			return None

		self.module.frappe.get_cached_value = get_cached_value
		self.profile.clear()
		self.profile.update(
			{
				"name": "Main POS",
				"company": "RetailMind",
				"posa_allow_offline_signed_cash_sales": 1,
				"posa_cash_mode_of_payment": "Cash",
				"posa_offline_signed_sale_max_amount": "10000",
				"posa_offline_signed_sale_ttl_minutes": 60,
				"posa_offline_signed_sale_ticket_batch_size": 3,
				"modified": "2026-08-01 12:00:00",
				"payments": [{"mode_of_payment": "Cash"}],
			}
		)
		self.stubs["pos_access"].current_user = "cashier@example.com"
		self.module._utcnow = type(self)._original_utcnow

	def issue_one(self):
		response = self.module.issue_offline_cash_sale_authorizations(
			pos_profile="Main POS",
			pin="2468",
			requested_count=1,
			document_type="Sales Invoice",
		)
		self.assertEqual(len(response["tickets"]), 1)
		return response["tickets"][0]

	def claims_for(self, ticket):
		return self.module.validate_offline_cash_sale_authorization(
			ticket["authorization"],
			profile_doc=self.profile,
			client_request_id=ticket["client_request_id"],
			document_type="Sales Invoice",
		)

	def cash_invoice(self, total="100", **overrides):
		invoice = {
			"is_pos": 1,
			"company_currency": "PKR",
			"currency": "PKR",
			"base_rounded_total": total,
			"rounded_total": total,
			"payments": [{"mode_of_payment": "Cash", "amount": total}],
		}
		invoice.update(overrides)
		return invoice

	def assert_authorization_failure(self, callback, resolution):
		with self.assertRaises(PermissionError) as raised:
			callback()
		outcome = self.module.extract_offline_cash_sale_failure(raised.exception)
		self.assertIsNotNone(outcome)
		self.assertEqual(outcome["resolution"], resolution)
		self.assertNotIn(
			self.module.OFFLINE_CASH_SALE_FAILURE_PREFIX,
			outcome["message"],
		)
		return outcome

	def test_ticket_is_bound_to_one_request_scope_and_cashier(self):
		ticket = self.issue_one()
		claims = self.claims_for(ticket)
		self.assertEqual(claims["cashier"], "cashier@example.com")
		self.assertEqual(claims["cash_mode_of_payment"], "Cash")
		self.assertEqual(claims["company_currency"], "PKR")
		self.assertEqual(claims["document_type"], "Sales Invoice")
		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_authorization(
				ticket["authorization"],
				profile_doc=self.profile,
				client_request_id="different-request",
				document_type="Sales Invoice",
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)

	def test_ticket_response_exposes_company_currency_without_exposing_claims(self):
		response = self.module.issue_offline_cash_sale_authorizations(
			pos_profile="Main POS",
			pin="2468",
			requested_count=1,
			document_type="Sales Invoice",
		)
		self.assertEqual(response["company_currency"], "PKR")
		self.assertEqual(response["tickets"][0]["company_currency"], "PKR")
		self.assertEqual(response["tickets"][0]["owner_user"], "cashier@example.com")
		self.assertNotIn("ticket_id", response["tickets"][0])

	def test_server_cash_policy_uses_company_currency_total_and_exact_cash_mop(self):
		ticket = self.issue_one()
		claims = self.claims_for(ticket)
		# Invoices may be priced in a foreign currency. The policy ceiling is
		# always evaluated against the server-owned company-currency total.
		invoice = self.cash_invoice(
			"100",
			currency="USD",
			rounded_total="1",
			base_rounded_total="100",
			payments=[
				{
					"mode_of_payment": "Cash",
					"amount": "1",
					"base_amount": "100",
				}
			],
		)
		self.assertTrue(
			self.module.validate_offline_cash_sale_document(
				claims, invoice, {"is_cashback": True}
			)
		)

		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_document(
				claims,
				self.cash_invoice(
					"100",
					payments=[{"mode_of_payment": "Card", "amount": "100"}],
				),
				{},
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_document(
				claims,
				self.cash_invoice("100", payments=[{"mode_of_payment": "Cash", "amount": "99"}]),
				{},
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_document(
				claims,
				self.cash_invoice("10001", payments=[{"mode_of_payment": "Cash", "amount": "10001"}]),
				{},
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)

	def test_cash_policy_rejects_non_pos_returns_invalid_and_negative_values(self):
		claims = self.claims_for(self.issue_one())
		invalid_cases = (
			("non-pos", self.cash_invoice("100", is_pos=0), {}),
			("return", self.cash_invoice("100", is_return=1), {}),
			(
				"negative-payment",
				self.cash_invoice("100", payments=[{"mode_of_payment": "Cash", "amount": "-1"}]),
				{},
			),
			(
				"non-finite-payment",
				self.cash_invoice("100", payments=[{"mode_of_payment": "Cash", "amount": "NaN"}]),
				{},
			),
			("non-finite-total", self.cash_invoice("NaN"), {}),
			(
				"gift-card-redemption",
				self.cash_invoice("100"),
				{"gift_card_redemptions": [{"amount": "Infinity"}]},
			),
		)
		for label, invoice, data in invalid_cases:
			with self.subTest(label=label):
				self.assert_authorization_failure(
					lambda: self.module.validate_offline_cash_sale_document(
						claims, invoice, data
					),
					self.module.SUPERVISOR_REVIEW_REQUIRED,
				)

		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_document(
				claims,
				self.cash_invoice(
					"100",
					company_currency="USD",
					currency="USD",
					base_rounded_total="100",
				),
				{},
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_document(
				claims,
				self.cash_invoice(
					"100",
					currency="USD",
					base_rounded_total=None,
					rounded_total="100",
				),
				{},
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)

	def test_non_finite_profile_maximum_cannot_enable_ticket_issuance(self):
		self.profile["posa_offline_signed_sale_max_amount"] = "NaN"
		with self.assertRaises(PermissionError):
			self.issue_one()

	def test_payload_hash_excludes_transient_credentials_but_keeps_sale_data(self):
		invoice = self.cash_invoice("100")
		data = {"idempotency_key": "same-command"}
		first = self.module.offline_cash_sale_payload_hash(
			{**invoice, "offline_sale_authorization": "old-ticket"},
			{**data, "cashier_pin": "2468"},
		)
		second = self.module.offline_cash_sale_payload_hash(
			{**invoice, "offline_sale_authorization": "replacement-ticket"},
			{**data, "cashier_pin": "9999"},
		)
		self.assertEqual(first, second)
		self.assertNotEqual(
			first,
			self.module.offline_cash_sale_payload_hash(
				self.cash_invoice("101"), data
			),
		)
		self.assertEqual(
			first,
			self.module.offline_cash_sale_payload_hash(
				{
					**invoice,
					"offline_sale_authorization": "another-ticket",
					"posa_pos_opening_shift": "POS-OPEN-RECOVERY-2",
					"_posa_shift_reassignment_audit": {"from": "POS-OPEN-1"},
				},
				{
					**data,
					"cashier_pin": "0000",
					"posa_pos_opening_shift": "POS-OPEN-RECOVERY-2",
				},
			),
		)

	def test_server_created_audit_resumes_after_ticket_expiry(self):
		ticket = self.issue_one()
		claims = self.claims_for(ticket)
		payload_hash = self.module.offline_cash_sale_payload_hash(
			self.cash_invoice("100"),
			{"idempotency_key": ticket["client_request_id"]},
		)
		audit = self.module.offline_cash_sale_authorization_audit(
			claims, payload_hash=payload_hash
		)
		resumed = self.module.validate_persisted_offline_cash_sale_audit(
			audit,
			profile_doc=self.profile,
			client_request_id=ticket["client_request_id"],
			document_type="Sales Invoice",
			payload_hash=payload_hash,
		)
		self.assertEqual(resumed["cashier"], "cashier@example.com")
		self.assertNotIn("authorization", audit)
		self.assertEqual(audit["company_currency"], "PKR")

	def test_persisted_ledger_resume_allows_policy_revision_but_requires_owner_or_supervisor(self):
		"""A server-owned ledger is historical authorization, not a new sale.

		The runtime may finish that exact ledger after a profile policy edit, but
		another cashier may not replay it.  A supervisor is the explicit recovery
		exception.
		"""
		ticket = self.issue_one()
		payload_hash = self.module.offline_cash_sale_payload_hash(
			self.cash_invoice("100"),
			{"idempotency_key": ticket["client_request_id"]},
		)
		audit = self.module.offline_cash_sale_authorization_audit(
			self.claims_for(ticket), payload_hash=payload_hash
		)
		self.profile.update(
			{
				"modified": "2026-08-01 12:01:00",
				"posa_cash_mode_of_payment": "Cash",
				"posa_offline_signed_sale_max_amount": "1",
			}
		)
		resumed = self.module.validate_persisted_offline_cash_sale_audit(
			audit,
			profile_doc=self.profile,
			client_request_id=ticket["client_request_id"],
			document_type="Sales Invoice",
			payload_hash=payload_hash,
		)
		self.assertEqual(resumed["cashier"], "cashier@example.com")

		self.stubs["pos_access"].current_user = "other-cashier@example.com"
		self.assert_authorization_failure(
			lambda: self.module.validate_persisted_offline_cash_sale_audit(
				audit,
				profile_doc=self.profile,
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
				payload_hash=payload_hash,
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)

		self.stubs["pos_access"].current_user = "supervisor@example.com"
		resumed = self.module.validate_persisted_offline_cash_sale_audit(
			audit,
			profile_doc=self.profile,
			client_request_id=ticket["client_request_id"],
			document_type="Sales Invoice",
			payload_hash=payload_hash,
		)
		self.assertEqual(resumed["cashier"], "cashier@example.com")

	def test_disabled_profile_cannot_issue_tickets(self):
		self.profile["posa_allow_offline_signed_cash_sales"] = 0
		with self.assertRaises(PermissionError):
			self.issue_one()

	def test_ticket_validation_marks_invalid_current_policy_for_manual_backoffice_review(self):
		ticket = self.issue_one()
		self.profile["posa_allow_offline_signed_cash_sales"] = 0
		outcome = self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_authorization(
				ticket["authorization"],
				profile_doc=self.profile,
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assertEqual(
			outcome.get("reason"),
			self.module.CURRENT_POLICY_REJECTS_COMMAND,
		)

	def test_ticket_issuance_requires_a_profile_assigned_cash_mode_of_payment(self):
		self.profile["payments"] = [{"mode_of_payment": "Card"}]
		with self.assertRaises(PermissionError):
			self.issue_one()

		self.profile["payments"] = [{"mode_of_payment": "Cash"}]
		self.module.frappe.get_cached_value = lambda *_args, **_kwargs: "Card"
		with self.assertRaises(PermissionError):
			self.issue_one()

	def test_ticket_rejects_another_invoice_document_type_or_profile_revision(self):
		ticket = self.issue_one()
		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_authorization(
				ticket["authorization"],
				profile_doc=self.profile,
				client_request_id=ticket["client_request_id"],
				document_type="POS Invoice",
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.profile["modified"] = "2026-08-01 12:01:00"
		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_authorization(
				ticket["authorization"],
				profile_doc=self.profile,
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)

	def test_expired_ticket_returns_typed_reauthorization_requirement(self):
		issued_at = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
		self.module._utcnow = lambda: issued_at
		ticket = self.issue_one()
		self.module._utcnow = lambda: issued_at + timedelta(hours=2)
		self.assert_authorization_failure(
			lambda: self.claims_for(ticket),
			self.module.REAUTHORIZATION_REQUIRED,
		)

	def test_reauthorization_binds_same_request_to_exact_payload_hash(self):
		issued_at = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
		self.module._utcnow = lambda: issued_at
		ticket = self.issue_one()
		invoice = self.cash_invoice("100", doctype="Sales Invoice", pos_profile="Main POS", company="RetailMind")
		data = {"idempotency_key": ticket["client_request_id"]}
		self.module._utcnow = lambda: issued_at + timedelta(hours=2)

		response = self.module.reauthorize_offline_cash_sale_authorization(
			pos_profile="Main POS",
			pin="2468",
			client_request_id=ticket["client_request_id"],
			document_type="Sales Invoice",
			invoice=invoice,
			data=data,
			offline_sale_authorization=ticket["authorization"],
		)
		self.assertEqual(response["approval_level"], self.module.REAUTHORIZATION_REQUIRED)
		replacement = response["ticket"]
		self.assertEqual(replacement["client_request_id"], ticket["client_request_id"])
		claims = self.module._decode_claims(replacement["authorization"])
		self.assertEqual(
			claims["payload_hash"],
			self.module.offline_cash_sale_payload_hash(
				{**invoice, "posa_client_request_id": ticket["client_request_id"]},
				{
					**data,
					"idempotency_key": ticket["client_request_id"],
					"client_request_id": ticket["client_request_id"],
				},
			),
		)
		self.assertEqual(claims["reauthorized_from_ticket_id"], self.module._decode_claims(ticket["authorization"])["ticket_id"])

		self.module.validate_offline_cash_sale_authorization(
			replacement["authorization"],
			profile_doc=self.profile,
			client_request_id=ticket["client_request_id"],
			document_type="Sales Invoice",
			payload_hash=claims["payload_hash"],
		)
		self.assert_authorization_failure(
			lambda: self.module.validate_offline_cash_sale_authorization(
				replacement["authorization"],
				profile_doc=self.profile,
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
				payload_hash="different-immutable-command",
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assert_authorization_failure(
			lambda: self.module.reauthorize_offline_cash_sale_authorization(
				pos_profile="Main POS",
				pin="2468",
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
				invoice=self.cash_invoice(
					"101",
					doctype="Sales Invoice",
					pos_profile="Main POS",
					company="RetailMind",
				),
				data=data,
				offline_sale_authorization=replacement["authorization"],
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)

	def test_reauthorization_rejects_conflicting_data_scope_before_minting_ticket(self):
		issued_at = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
		self.module._utcnow = lambda: issued_at
		ticket = self.issue_one()
		self.module._utcnow = lambda: issued_at + timedelta(hours=2)
		original_issue = self.module._issue_ticket_claims

		def no_replacement_ticket(**_kwargs):
			raise AssertionError("a conflicting queued payload must not mint a replacement ticket")

		self.module._issue_ticket_claims = no_replacement_ticket
		self.addCleanup(setattr, self.module, "_issue_ticket_claims", original_issue)
		for data in (
			{"pos_profile": "Other POS"},
			{"company": "Other Company"},
		):
			with self.subTest(data=data):
				self.assert_authorization_failure(
					lambda: self.module.reauthorize_offline_cash_sale_authorization(
						pos_profile="Main POS",
						pin="2468",
						client_request_id=ticket["client_request_id"],
						document_type="Sales Invoice",
						invoice=self.cash_invoice(
							"100",
							doctype="Sales Invoice",
							pos_profile="Main POS",
							company="RetailMind",
						),
						data=data,
						offline_sale_authorization=ticket["authorization"],
						),
						self.module.SUPERVISOR_REVIEW_REQUIRED,
					)

	def test_policy_changed_reauthorization_requires_supervisor_pin(self):
		issued_at = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
		self.module._utcnow = lambda: issued_at
		ticket = self.issue_one()
		invoice = self.cash_invoice(
			"100", doctype="Sales Invoice", pos_profile="Main POS", company="RetailMind"
		)
		self.profile["modified"] = "2026-08-01 12:01:00"
		self.module._utcnow = lambda: issued_at + timedelta(hours=2)

		self.assert_authorization_failure(
			lambda: self.module.reauthorize_offline_cash_sale_authorization(
				pos_profile="Main POS",
				pin="2468",
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
				invoice=invoice,
				data={},
				offline_sale_authorization=ticket["authorization"],
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		response = self.module.reauthorize_offline_cash_sale_authorization(
			pos_profile="Main POS",
			pin="9999",
			client_request_id=ticket["client_request_id"],
			document_type="Sales Invoice",
			invoice=invoice,
			data={},
			offline_sale_authorization=ticket["authorization"],
		)
		self.assertEqual(response["approval_level"], self.module.SUPERVISOR_REVIEW_REQUIRED)
		self.assertEqual(response["ticket"]["cashier"], "supervisor@example.com")

	def test_reauthorization_refuses_a_replacement_that_exceeds_the_current_cap(self):
		issued_at = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
		self.module._utcnow = lambda: issued_at
		ticket = self.issue_one()
		self.profile.update(
			{
				"modified": "2026-08-01 12:01:00",
				"posa_offline_signed_sale_max_amount": "1",
			}
		)
		self.module._utcnow = lambda: issued_at + timedelta(hours=2)

		outcome = self.assert_authorization_failure(
			lambda: self.module.reauthorize_offline_cash_sale_authorization(
				pos_profile="Main POS",
				pin="9999",
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
				invoice=self.cash_invoice("100"),
				data={},
				offline_sale_authorization=ticket["authorization"],
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assertIn("maximum", outcome["message"].lower())

	def test_reauthorization_refuses_a_replacement_with_a_different_cash_mop(self):
		issued_at = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
		self.module._utcnow = lambda: issued_at
		ticket = self.issue_one()
		self.profile.update(
			{
				"modified": "2026-08-01 12:01:00",
				"posa_cash_mode_of_payment": "Counter Cash",
				"payments": [{"mode_of_payment": "Counter Cash"}],
			}
		)
		def cached_value(doctype, name, fieldname):
			if (doctype, name, fieldname) == ("Mode of Payment", "Counter Cash", "type"):
				return "Cash"
			if (doctype, name, fieldname) == ("Company", "RetailMind", "default_currency"):
				return "PKR"
			return None
		self.module.frappe.get_cached_value = cached_value
		self.module._utcnow = lambda: issued_at + timedelta(hours=2)

		outcome = self.assert_authorization_failure(
			lambda: self.module.reauthorize_offline_cash_sale_authorization(
				pos_profile="Main POS",
				pin="9999",
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
				invoice=self.cash_invoice("100"),
				data={},
				offline_sale_authorization=ticket["authorization"],
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assertIn("mode of payment", outcome["message"].lower())

	def test_disabled_profile_returns_a_typed_manual_recovery_outcome(self):
		issued_at = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
		self.module._utcnow = lambda: issued_at
		ticket = self.issue_one()
		self.profile["posa_allow_offline_signed_cash_sales"] = 0
		self.module._utcnow = lambda: issued_at + timedelta(hours=2)

		outcome = self.assert_authorization_failure(
			lambda: self.module.reauthorize_offline_cash_sale_authorization(
				pos_profile="Main POS",
				pin="9999",
				client_request_id=ticket["client_request_id"],
				document_type="Sales Invoice",
				invoice=self.cash_invoice("100"),
				data={},
				offline_sale_authorization=ticket["authorization"],
			),
			self.module.SUPERVISOR_REVIEW_REQUIRED,
		)
		self.assertIn("current pos profile policy", outcome["message"].lower())
		self.assertEqual(
			outcome.get("reason"),
			self.module.CURRENT_POLICY_REJECTS_COMMAND,
		)


if __name__ == "__main__":
	unittest.main()
