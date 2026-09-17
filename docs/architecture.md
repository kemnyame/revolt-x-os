# Core architecture

The API is a modular TypeScript service backed by PostgreSQL. Tenant isolation is enforced at repository queries and permission checks. Mutations that change business state run in transactions together with audit records and outbox events.

Authentication uses password hashes, rotating opaque refresh tokens stored only as SHA-256 hashes, and short-lived signed access tokens. Every authenticated request verifies that its server-side session and organisation membership remain active.

The Operations Hub is the common coordination surface. External modules may create work using a stable `source_module` and `external_ref`. The Workflow Engine stores immutable definition versions, ordered steps and durable instance/step state. The initial executor supports controlled manual completion while its schema already represents task, approval, webhook, condition and delay step types. Automated workers can be added as separate processes consuming persisted runs.

Integration uses versioned HTTP APIs and transactional outbox events. `module_clients` supplies tenant-scoped machine identities. AI is not embedded: Core OS forwards authorised capability requests to the independently deployed AI Gateway.
