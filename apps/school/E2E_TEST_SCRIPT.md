# Revolt-X School End-to-End Test Script

**Environment:** https://revolt-x-school.onrender.com  
**Purpose:** Full functional verification of the School vertical and its Core Revolt-X OS identity bridge.

> Run tests in order. Use test/demo records where a step changes data. Record PASS, FAIL, BLOCKED, and notes for every test.  
> External-provider tests may be BLOCKED until production credentials/domain approvals are complete. A blocked provider test is not an application pass.

## Test record

| ID | Area | Result | Notes |
|---|---|---|---|
| E2E-001 | Admin bootstrap |  |  |
| E2E-002 | System Check |  |  |
| E2E-003 | School Setup |  |  |
| E2E-004 | Academic Manager |  |  |
| E2E-005 | Access Management |  |  |
| E2E-006 | Global Search |  |  |
| E2E-007 | Student 360 |  |  |
| E2E-008 | Attendance |  |  |
| E2E-009 | Assessment scheme |  |  |
| E2E-010 | Teacher scores |  |  |
| E2E-011 | Homework |  |  |
| E2E-012 | Lesson Notes |  |  |
| E2E-013 | Timetable |  |  |
| E2E-014 | Public admission |  |  |
| E2E-015 | Admission tracking |  |  |
| E2E-016 | Admission review/contact |  |  |
| E2E-017 | Admission enrolment |  |  |
| E2E-018 | Fees assignment |  |  |
| E2E-019 | Cash/manual payment |  |  |
| E2E-020 | Parent payment request |  |  |
| E2E-021 | Online card/MoMo |  |  |
| E2E-022 | Parent portal |  |  |
| E2E-023 | Student portal |  |  |
| E2E-024 | Report draft |  |  |
| E2E-025 | Report approval |  |  |
| E2E-026 | Report family release |  |  |
| E2E-027 | Promotion/Rollover |  |  |
| E2E-028 | Communication Centre |  |  |
| E2E-029 | Roles/Privileges |  |  |
| E2E-030 | Audit/negative checks |  |  |

## E2E-001 Admin bootstrap

1. Open the School Admin URL.
2. Allow the current authenticated/preview bootstrap to finish.
3. Confirm the Dashboard loads rather than showing a Core OS authentication error.
4. Refresh the page twice.
5. Navigate away and back to Dashboard.

**Expected:** Dashboard consistently loads; no 429/502 authentication failure; current school/user context is displayed.

## E2E-002 System Check

1. Open **System Check**.
2. Click **Run again**.
3. Review every check.

**Expected:** Internal checks are PASS. Email/SMS/WhatsApp/online-payment items may be WARNING until external providers are fully connected. There must be no unexplained FAIL.

## E2E-003 School Setup

1. Open **School Setup**.
2. Confirm school name, contact details, academic year, terms and grade levels load.
3. Edit a harmless school field and save it, then restore it.
4. Open Term 1 and confirm **Next term begins** is 2027-01-12.
5. Open Term 2 and confirm **Next term begins** is 2027-05-04.

**Expected:** Changes persist after refresh. Report-card next-term dates come from Term Setup, not from teacher entry.

## E2E-004 Academic Manager

1. Open **Academic Manager**.
2. Confirm all active classes display.
3. Select a class and confirm its curriculum subjects display together.
4. Confirm class teacher and subject teachers are visible.
5. Create a temporary test subject/class link, assign a teacher, verify, then remove the temporary link if safe.
6. Refresh.

**Expected:** Screen loads even if Core staff directory is temporarily waking. Existing classes, curriculum and assignments remain visible. Teacher assignment changes persist.

## E2E-005 Access Management

1. Open **Access Management**.
2. Inspect Staff Directory, Teaching Assignments, User Access, Roles & Privileges and Report Reviewers.
3. Confirm active School memberships display.
4. Confirm teaching assignments match Academic Manager.
5. Change a non-critical test role permission, save, verify, then restore it.

**Expected:** School access and academic assignment data remain consistent across screens.

## E2E-006 Global Search

Search, one at a time, for:
- a student name;
- an admission number;
- a guardian phone;
- a class;
- a subject;
- an admission reference;
- a staff name;
- a fee/payment reference where available.

**Expected:** Results appear while typing. Clicking a student opens the Student 360 view; other results open the appropriate module.

## E2E-007 Student 360

1. Open a test student from Students or global search.
2. Verify biodata, active class, guardian, attendance, assessments, homework, fees/payments and report information.
3. Confirm portal controls are visible to authorised admins.

**Expected:** Data matches the same records in the source modules.

## E2E-008 Attendance

1. Open Attendance.
2. Select a class and test date.
3. Mark several students present/absent/late/excused.
4. Save.
5. Reload the same class/date.

**Expected:** Marks persist exactly; teacher scope prevents unauthorised class access.

## E2E-009 Assessment scheme

1. Open **Assessments & Scores**.
2. Confirm the active term scheme totals 100%.
3. Confirm categories show their fixed weights.
4. Create a temporary classwork exercise with a valid maximum mark.
5. Verify creating multiple exercises does not increase the category weight.

**Expected:** Category weighting remains fixed and exercises are grouped under categories.

## E2E-010 Teacher scores

1. Open Teacher Portal.
2. Open Assessments & Scores for a teacher-assigned class/subject.
3. Enter raw scores for a test exercise.
4. Save and reload.
5. Open the student's report/360 academic view.

**Expected:** Scores persist, cannot exceed the assessment maximum, and weighted results update.

## E2E-011 Homework

1. In Teacher Portal create homework for an assigned class/subject.
2. Publish it.
3. Open Parent Portal and Student Portal for a linked student.
4. Confirm homework appears.
5. Record/update submission status and score from the teacher side if applicable.

**Expected:** Published homework flows to the correct family/student only and updates persist.

## E2E-012 Lesson Notes & Teaching Log

1. Teacher creates a Lesson Note with class, subject, week, date, strand, objective, resources and activities.
2. Save draft.
3. Submit for review.
4. Headteacher/admin opens Lesson Notes and approves it.
5. Teacher records the Teaching Log and reflection.

**Expected:** Workflow is Draft -> Submitted -> Approved -> Taught. Returned notes become editable again.

## E2E-013 Timetable & scheduling

1. Open Timetable.
2. Filter school-wide, by class and by individual teacher.
3. Confirm Teacher Portal shows only the teacher's timetable.
4. Confirm Student/Parent portals show the student's class timetable.
5. Run **Check schedule**.
6. Try creating an overlapping class period and confirm rejection.
7. Try double-booking a teacher and confirm rejection.
8. Try creating a period over a configured break and confirm rejection.
9. Export CSV and Print/Save PDF.

**Expected:** Filters, clash detection, scheduling rules and exports work.

## E2E-014 Public admission

1. Open /admissions in a private/incognito browser.
2. Submit a test applicant with a real test guardian email/phone where possible.
3. Save the generated admission reference.

**Expected:** Application is created as external/submitted and appears immediately in Admin Admissions.

## E2E-015 Admission tracking

1. In the public Admissions page enter only the admission reference.
2. Track the application before and after each admin status change.

**Expected:** Public view shows reference, status and progress timestamps but no private guardian/reviewer information.

## E2E-016 Admission review/contact

1. Admin opens the full admission record.
2. Move status to Under Review.
3. Add a review note.
4. Test Call.
5. Test Email/SMS/WhatsApp only where the provider is connected.
6. Approve the application.

**Expected:** Status history records each change; contact attempts are logged; configured channels show sent/failed accurately rather than pretending delivery.

## E2E-017 Admission enrolment

1. With an approved test applicant click Enrol.
2. Choose the correct class.
3. Allow the system to generate an admission number.
4. Search for the new student.

**Expected:** Student, guardian link and active enrolment are created; admission becomes Enrolled; mandatory fees are assigned automatically; admission history records the transition.

## E2E-018 Fees assignment

1. Open Fees & Payments.
2. Open the newly enrolled test student.
3. Verify all mandatory fees applicable to the academic year/grade are already assigned.
4. Assign an optional test fee if needed.

**Expected:** No duplicate fee assignments; balances are correct.

## E2E-019 Cash/manual payment

1. Post a small test cash/manual payment against a student's outstanding fee.
2. Confirm balance reduces.
3. Generate the receipt.
4. Verify the same payment in Student 360 and Parent Portal.
5. Void the test payment with a reason, if the test record can safely be reversed.

**Expected:** Ledger, fee status, receipt and void handling remain consistent.

## E2E-020 Parent payment request

1. From Fees & Payments create a payment request for a linked guardian.
2. Open Parent Portal.
3. Confirm request appears with amount/fee/note.
4. Cancel a separate test request from Admin and verify it disappears from open parent requests.

**Expected:** Requests flow correctly between School and Parent Portal.

## E2E-021 Online card/Mobile Money

**Prerequisite:** Paystack test/live secret key configured.

1. In Parent Portal choose an outstanding fee/request.
2. Select Mobile Money or Card.
3. Complete a Paystack test transaction.
4. Return to Parent Portal.
5. Verify intent status becomes success and a payment is posted exactly once.

**Expected:** Provider verification occurs before ledger settlement; duplicate callbacks do not create duplicate payments.

**If provider is not configured:** mark BLOCKED, not PASS.

## E2E-022 Parent Portal

1. Sign in with a provisioned guardian phone, linked admission number and PIN.
2. Confirm only linked children appear.
3. Open Dashboard, Homework, Fees & Payments, Timetable, Report Card and Announcements.
4. Sign out.
5. Confirm protected data cannot be loaded after logout.

**Expected:** Guardian can access only linked children and approved/released information.

## E2E-023 Student Portal

1. Provision/reset a test student's PIN.
2. Sign in using admission number + PIN.
3. Open Dashboard, Homework, Timetable, approved Report Card and Announcements.
4. Sign out.

**Expected:** Student sees only their own data.

## E2E-024 Report draft

1. Class teacher enters scores for the selected student.
2. Open Report Cards.
3. Add class teacher remark, conduct and interests.
4. Confirm **Next term begins** is automatically inherited from Term Setup.
5. Save draft.
6. Submit for review.

**Expected:** Status changes Draft -> Submitted; teacher can no longer edit while submitted.

## E2E-025 Report approval

1. Headteacher/assigned reviewer opens Approval Queue.
2. Review academic results and teacher remark.
3. Return one test report with a correction note.
4. Teacher corrects and resubmits.
5. Reviewer adds headteacher remark and approves.

**Expected:** Returned workflow works; final status is Approved; audit records are created.

## E2E-026 Report family release

1. Before approval, check Parent/Student Portal.
2. After approval, check again.

**Expected:** Unapproved report is hidden. Approved report appears with weighted results, teacher/headteacher remarks and next-term date.

## E2E-027 Promotion & Rollover

**Use only designated test students/year/classes.**

1. Create/confirm the destination academic year and destination classes.
2. Open Promotion & Rollover.
3. Preview a source class.
4. Mark one test student Promoted, one Repeated where appropriate, or Completed for a final-year test.
5. Process.
6. Inspect Student 360 and enrolments.
7. Inspect fees for promoted/repeated student.

**Expected:** Old enrolment closes with correct outcome, destination enrolment becomes active, promotion history is recorded and destination-year mandatory fees are assigned automatically.

## E2E-028 Communication Centre

1. Open Communication Centre.
2. Review provider connection status.
3. Send one direct email to an allowed real test address.
4. Send SMS and WhatsApp only if Twilio is configured.
5. Trigger an admission or fee notification.
6. Inspect Outbox.

**Expected:** Each message is Sent, Failed or Pending Configuration truthfully with error details.

Current production prerequisites:
- Resend: verified sending domain required to send to arbitrary recipients.
- Twilio SMS: credentials plus appropriate Ghana sender/Messaging Service configuration.
- WhatsApp: registered sender and approved template for business-initiated notifications where required.

## E2E-029 Roles & Privileges

1. Select Teacher role.
2. Verify it cannot perform admin-only school setup/role actions.
3. Verify teacher can access only assigned classes/subjects.
4. Test Bursar access to fees and lack of academic-score privileges.
5. Test Registrar admission/student access.
6. Restore any changed permissions.

**Expected:** Backend rejects forbidden actions even if an API request is attempted directly.

## E2E-030 Audit and negative checks

Verify the following:
1. Invalid portal PIN is rejected.
2. Student cannot access another student's portal data.
3. Guardian cannot access an unlinked child.
4. Score above maximum is rejected.
5. Payment above outstanding balance is rejected.
6. Timetable collision is rejected.
7. Admission cannot be enrolled before Approved.
8. Submitted/approved report cannot be edited by class teacher until returned.
9. Deleted/voided financial activity remains auditable.
10. Audit log contains representative create/edit/approve/payment/promotion events.

**Expected:** Every negative case fails safely with an understandable error and leaves data unchanged.

## Exit criteria

The release passes internal E2E when:
- System Check has no unexplained FAIL.
- E2E-001 through E2E-030 have recorded results.
- All critical School workflows are PASS.
- External-provider cases are either PASS or explicitly BLOCKED with the exact missing credential/approval documented.
- No unexpected 4xx/5xx responses appear in live logs during the test.
- No database-integrity check regresses after the test.
