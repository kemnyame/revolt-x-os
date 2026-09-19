-- Initialise accrual accounting for existing School fee assignments and valid payments.

INSERT INTO finance_journal_entries(
  organisation_id,entry_no,entry_date,description,source_type,source_id,status,created_by_os_user_id,posted_at
)
SELECT sf.organisation_id,
       'JRN-FEE-'||replace(sf.id::text,'-',''),
       sf.created_at::date,
       'School fee receivable - '||s.first_name||' '||s.last_name||' ('||s.admission_no||') - '||f.name,
       'student_fee',sf.id,'posted',NULL,sf.created_at
FROM student_fees sf
JOIN students s ON s.id=sf.student_id
JOIN fee_items f ON f.id=sf.fee_item_id
WHERE (sf.amount_due-sf.discount)>0
  AND NOT EXISTS(
    SELECT 1 FROM finance_journal_entries je
    WHERE je.organisation_id=sf.organisation_id AND je.source_type='student_fee' AND je.source_id=sf.id
  );

INSERT INTO finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
SELECT je.id,ar.id,f.name||' receivable',(sf.amount_due-sf.discount),0
FROM student_fees sf
JOIN fee_items f ON f.id=sf.fee_item_id
JOIN finance_journal_entries je ON je.organisation_id=sf.organisation_id AND je.source_type='student_fee' AND je.source_id=sf.id
JOIN finance_accounts ar ON ar.organisation_id=sf.organisation_id AND ar.code='1100'
WHERE NOT EXISTS(SELECT 1 FROM finance_journal_lines jl WHERE jl.journal_entry_id=je.id)
  AND (sf.amount_due-sf.discount)>0;

INSERT INTO finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
SELECT je.id,inc.id,f.name||' income',0,(sf.amount_due-sf.discount)
FROM student_fees sf
JOIN fee_items f ON f.id=sf.fee_item_id
JOIN finance_journal_entries je ON je.organisation_id=sf.organisation_id AND je.source_type='student_fee' AND je.source_id=sf.id
JOIN finance_accounts inc ON inc.organisation_id=sf.organisation_id AND inc.code='4000'
WHERE (SELECT count(*) FROM finance_journal_lines jl WHERE jl.journal_entry_id=je.id)=1
  AND (sf.amount_due-sf.discount)>0;

INSERT INTO finance_journal_entries(
  organisation_id,entry_no,entry_date,description,source_type,source_id,status,reference,created_by_os_user_id,posted_at
)
SELECT p.organisation_id,
       'JRN-PAY-'||replace(p.id::text,'-',''),
       p.paid_at::date,
       'School fee payment - '||s.first_name||' '||s.last_name||' ('||s.admission_no||')',
       'student_payment',p.id,'posted',p.reference,p.received_by_os_user_id,p.paid_at
FROM payments p
JOIN students s ON s.id=p.student_id
WHERE p.voided_at IS NULL
  AND NOT EXISTS(
    SELECT 1 FROM finance_journal_entries je
    WHERE je.organisation_id=p.organisation_id AND je.source_type='student_payment' AND je.source_id=p.id
  );

INSERT INTO finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
SELECT je.id,cash.id,p.payment_method||' receipt',p.amount,0
FROM payments p
JOIN finance_journal_entries je ON je.organisation_id=p.organisation_id AND je.source_type='student_payment' AND je.source_id=p.id
JOIN finance_accounts cash ON cash.organisation_id=p.organisation_id
 AND cash.code=CASE p.payment_method
   WHEN 'mobile_money' THEN '1020'
   WHEN 'card' THEN '1030'
   WHEN 'bank' THEN '1010'
   ELSE '1000'
 END
WHERE p.voided_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM finance_journal_lines jl WHERE jl.journal_entry_id=je.id);

INSERT INTO finance_journal_lines(journal_entry_id,account_id,description,debit,credit)
SELECT je.id,
       CASE WHEN p.student_fee_id IS NOT NULL THEN ar.id ELSE inc.id END,
       CASE WHEN p.student_fee_id IS NOT NULL THEN 'Accounts receivable settlement' ELSE 'School fees income' END,
       0,p.amount
FROM payments p
JOIN finance_journal_entries je ON je.organisation_id=p.organisation_id AND je.source_type='student_payment' AND je.source_id=p.id
JOIN finance_accounts ar ON ar.organisation_id=p.organisation_id AND ar.code='1100'
JOIN finance_accounts inc ON inc.organisation_id=p.organisation_id AND inc.code='4000'
WHERE p.voided_at IS NULL
  AND (SELECT count(*) FROM finance_journal_lines jl WHERE jl.journal_entry_id=je.id)=1;
