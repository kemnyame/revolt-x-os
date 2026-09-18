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
- messaging providers
- document/object storage for uploads
- stronger teacher/class scoping
- backup and monitoring policies
- production-grade hosting tiers
- removal of preview access
