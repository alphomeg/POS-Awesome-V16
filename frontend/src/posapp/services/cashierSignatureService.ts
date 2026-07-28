import api from "./api";

const VALIDATE_CASHIER_SIGNATURE_METHOD =
	"posawesome.posawesome.api.employees.validate_cashier_signature";

export interface CashierSignatureValidation {
	valid: boolean;
}

export function validateCashierSignature(
	posProfile: string,
	cashierPin: string,
): Promise<CashierSignatureValidation> {
	return api.call<CashierSignatureValidation>(
		VALIDATE_CASHIER_SIGNATURE_METHOD,
		{
			pos_profile: posProfile,
			pin: cashierPin,
		},
		{
			timeoutMs: 10_000,
		},
	);
}
