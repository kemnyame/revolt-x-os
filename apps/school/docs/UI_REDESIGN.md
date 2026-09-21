# Revolt-X School UI redesign — 21 September 2026

A shared light interface now covers administration, teaching, parent and student portals, staff sign-in and public admissions. It adds responsive navigation, consistent forms and tables, accessible dialogs, keyboard child switching, readable dashboard metrics and versioned shared presentation assets. No external fonts, image downloads or new production dependencies are required.

Existing permissions, authentication, API contracts, financial posting, approval rules, database schemas and Core OS boundaries remain unchanged. Dashboards use the existing data endpoints. Their shortcuts invoke the existing permission-checked page handlers.

Two concrete issues found during verification were fixed:

- Student 360 used `dataset.student360` for `data-student-360`; digit-containing attributes do not map to that key. The existing modal is now opened using the exact attribute.
- Request timing entries are cleared for static/page responses as well as API responses, avoiding memory growth as presentation assets are requested. API audit logging remains intact.

## Verification completed

- School TypeScript build, six portal script validations, shared design script validation and all 15 existing smoke tests pass.
- Core OS build and all five existing tests pass.
- All 36 School migrations apply in isolated PGlite PostgreSQL with the pg_trgm extension enabled. No production migrations or data were modified.
- Chromium layout checks cover all six entry points at 360, 390, 768, 1024, 1440 and 1920 CSS pixels. No document overflow or browser JavaScript errors were detected.
- Browser interaction checks cover mobile navigation, student filtering, Student 360, retaining the student list when opening a separate student page, teacher attendance selection, dialog focus containment and Escape, finance tabs, keyboard child switching, parent payment options and the unreleased-report gate.

Browser checks used isolated synthetic response fixtures with all writes disabled. They verify rendering and existing UI interactions, not live database writes, payment-provider settlement, email delivery or every possible role/data combination. Production sign-in and a controlled operational smoke check should follow deployment.

## Release

Deploy the existing School service from this repository using its existing build command and configuration. No environment changes are needed. The shared design URLs contain a content hash; they are cached for one hour. School application HTML and scripts retain the existing refresh behaviour. Core OS requires no deployment for this UI update.
