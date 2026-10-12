# Revolt-X School

Revolt-X School is a Primary and JHS management application built on top of Core Revolt-X OS.

## Architecture

Revolt-X School is not part of the Core OS domain model. It is a separate business application that consumes Core OS identity and organisation context through APIs.

```text
Users
  |
  v
Revolt-X School
  |-- Students
  |-- Guardians
  |-- Academic Years & Terms
  |-- Primary 1-6 / JHS 1-3
  |-- Classes & Subjects
  |-- Attendance
  |-- Assessments & Scores
  |-- Report Cards
  |-- Fees & Payments
  |-- Timetable
  |
  +--> Core Revolt-X OS
       |-- Organisation identity
       |-- User identity
       |-- Sessions
       |-- Base permissions
       |-- Audit/security foundation
       |-- Future workflows, notifications and AI gateway
```

The School service validates the user's Core OS access token by calling `GET /v1/auth/context` on Core OS. It never reads the Core OS database directly.

School-specific data is stored in its own PostgreSQL database under the `revolt_x_school` schema.

## Current functional modules

- School profile
- Academic years and three-term calendar
- Primary 1-6 and JHS 1-3 grade setup
- Classes and subjects
- Student admissions and enrolment
- Guardians
- Daily attendance
- Assessments and score entry
- Term report cards
- Fee items, fee assignment and payment recording
- Timetable
- School-specific staff roles
- School audit trail
- Live dashboard

## School roles

- `school_admin`
- `headteacher`
- `teacher`
- `bursar`
- `registrar`

These roles are module-specific. Core OS still controls the master organisation identity and user account.

## Development access

During development, the School frontend obtains the temporary Core OS preview session through the School backend. This must be replaced by the production Core OS login/SSO flow before a public launch.

## Production hardening still required

- production Core OS login/MFA
- parent and student portals
- secure password/reset delivery
- payment gateway integration
- messaging providers (Brevo transactional email is supported; Twilio SMS/WhatsApp remain optional)
- document/object storage for uploads
- stronger teacher/class scoping
- backup and monitoring policies
- production-grade hosting tiers
- removal of preview access


## Mobile application

Open `/mobile` on Android or iPhone. No software download is required. The four
workspace choices open the existing staff, parent, student and administrator
sign-in pages and use the same school records and permissions. Staff continue
to use Staff ID and password; administrator authentication remains separate.

Phone layouts include quick navigation, larger touch controls, bottom tabs,
safe-area spacing and readable forms. `/mobile?school=<school-code>` carries the
school selection to each workspace. All portals advertise the app manifest and
icons so visitors can optionally add a home-screen shortcut. Installation is
never required to use the application.

The service worker only handles same-origin document navigation. It does not
cache student records, credentials, API responses or authenticated pages and
does not queue mutations or payments. Offline navigation displays a generic
reconnect page. School operations require an internet connection. Browser and
device support determines whether a home-screen installation option is shown.

Run `npm test` to build and validate the application, including mobile routes,
manifest targets, icons and offline privacy behavior.

## Transactional email

Revolt-X School supports Brevo for automated transactional email. Set:

- `EMAIL_PROVIDER=brevo`
- `BREVO_API_KEY`
- `BREVO_FROM_EMAIL` to a sender verified in Brevo
- `BREVO_FROM_NAME` (for example, `Revolt-X School`)

When configured, the existing communication outbox and notification rules send guardian/staff notifications through Brevo, including fee-payment confirmations, fee-payment requests, report workflow alerts and released report-card notifications. Provider message IDs are stored in the communication outbox for audit and retry.
