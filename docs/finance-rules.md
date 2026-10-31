# Finance Rules

- Currency: EGP, all amounts stored as integer piasters (minor units).
- No tax/VAT: No tax/VAT fields or calculations anywhere in the system.
- Separation of concepts: Charges, payments, refunds, and expenses are distinct entities. They are never double-counted.
- Charges: Billed amounts for services. Can be VOID. Created separately from payments.
- Payments: Money received from patients. Can be allocated to charges or left unallocated (deposits/credit). Status COMPLETED.
- Refunds: Money returned to patients. Capped at payment.amount - alreadyRefunded. Tracked separately.
- Deposits/Credit: Unallocated payments create patient credit (unallocatedMinor). This is not counted as "collected" in a way that double-counts against outstanding balances.
- Expenses: Clinic costs, not linked to patients. Can be VOIDED with reason (original entry preserved).
- Ledger: /patients/:id/ledger shows all financial activity. Outstanding = charges not covered by allocated payments. Balance can be positive (credit held) or negative (amount owed).
- Reports: Daily/monthly reports show charges, payments, refunds, expenses separately with clear totals (collected, billed, net cash).
- Accounting export: CSV export with one row per charge/payment/refund/expense, amounts in piasters with currency column for reconciliation.
