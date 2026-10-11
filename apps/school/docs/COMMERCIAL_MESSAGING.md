# Revolt School: domain and commercial messaging activation

The usable free application address is https://revolt-x-school.onrender.com/login.
Its HTTPS address can be used for school demonstrations, admissions and portals
without buying a domain. Render controls the onrender.com DNS zone, so it cannot
be used as a verified Revolt email sending domain.

## Free custom-address option

EU.org accepts applications for delegated addresses such as
`revoltschool.eu.org`, subject to availability, its policies and manual approval.
That example is not registered or reserved. Registration requires an account,
accurate owner contact information and working authoritative DNS nameservers.
DNS hosting must allow separate TXT, CNAME and MX records. See:

- https://nic.eu.org/register.html
- https://nic.eu.org/policy.html
- https://nic.eu.org/top-policy.html

Once delegated, connect the address to the existing Render service and configure
the exact email authentication records returned by the sending provider. Do not
use DNS records from another domain or assume that adding a name in Resend proves
ownership. Custom address changes require updates to PUBLIC_BASE_URL and provider
callbacks. Keep the current address available during that change.

## Email activation

The connected Resend account currently has failed verification for `revolt.school`
and `notify.school`. Their presence in Resend does not demonstrate ownership.
The existing test sender supports only the configured account-owner test recipient.
Parent messages now wait for configuration; the application never redirects their
content to the owner while marking the original recipient as contacted.

1. Obtain control of a sending domain or a delegated subdomain with full DNS access.
2. Add that domain in Resend and publish its exact authentication records.
3. Confirm Resend reports the domain as verified with sending enabled. Configure
   DMARC for the sending domain and begin with a monitored policy.
4. Set EMAIL_PROVIDER=resend, RESEND_FROM_EMAIL to an address on that verified
   domain and EMAIL_DELIVERY_MODE=production in the School service. An optional
   EMAIL_REPLY_TO may point to the school or support inbox.
5. Open Communication Centre and choose Check connections. If the API key is
   restricted to sending, domain checks may require manual verification in Resend.
6. Send a specifically authorised test to a consenting recipient, check the
   provider log and confirm receipt. Then review and retry waiting messages.

Resend's free transactional tier is an option for initial low-volume use. Its
current published limits are at https://resend.com/pricing; these are shared by
the account and should be checked before a school-wide report-card release.

## WhatsApp activation

School supports Meta Cloud API directly and retains Twilio support for existing
accounts. The marketing contact number 0557485233 is not automatically treated
as an approved API sender. A real business sending number must be selected and
registered with the provider. Do not remove an existing WhatsApp registration
without checking the provider's supported onboarding or coexistence process.

For Meta, configure these in the School hosting environment, never in Git:

| Variable | Required value |
| --- | --- |
| WHATSAPP_PROVIDER | meta |
| WHATSAPP_TOKEN | Production system-user access token with access to the sending number |
| WHATSAPP_PHONE_NUMBER_ID | Meta's sending-number ID, not the public phone number |
| WHATSAPP_BUSINESS_ACCOUNT_ID | Business account ID for template approval checks |
| WHATSAPP_API_VERSION | A supported pinned version, currently configured as v25.0 |
| WHATSAPP_TEMPLATE_NAME | Exact approved template name |
| WHATSAPP_TEMPLATE_LANGUAGE | Exact approved language, default en_GB |
| WHATSAPP_ALLOW_SESSION_MESSAGES | false for automated commercial alerts |

The supported template contract uses exactly three positional **body** variables:
recipient name, subject and notification details. Use an approved text-only
template compatible with that contract; templates with required header or button
parameters require additional mapping. Meta determines the category and approval.
The connection check verifies the configured number is accessible and, when the
Business Account ID is supplied, that the matching body template is approved.

Twilio deployments use a complete API Key SID/Secret pair or Account SID/Auth
Token, plus a production WhatsApp sender and approved Content SID with the same
three-variable contract. A partially configured API key no longer overrides a
valid Auth Token. A sandbox is not a commercial sender.

Capture parent permission before enabling their WhatsApp alerts. Automatic
business-initiated alerts use templates; free-form messages require an active
24-hour customer-service window and are disabled by default. Provider fees for
paid message categories remain separate from hosting and depend on destination
and category: https://business.whatsapp.com/products/platform-pricing.

## Delivery and retry behaviour

- Immediate sending, manual retry and the background worker share one atomic
  database claim. A row already being sent or accepted is not sent a second time.
- Resend requests use the outbox ID as an idempotency key. The exact branded HTML
  is saved so retries do not change the request body. Resend's key retention is
  24 hours; manually review old uncertain attempts before resending them.
- Setup problems wait without consuming the automatic retry budget. Rate limits
  and safe transient errors use backoff. Invalid recipients and uncertain
  non-idempotent outcomes stop automatic retry and retain an actionable error.
- Submitted means the provider accepted the request. This change does not add
  delivery-status webhooks, so it does not certify inbox or handset receipt.
- Connection checks are authenticated and read-only. They send no test messages
  and expose no API tokens. Final live delivery requires a verified sender and
  an explicitly authorised recipient test.
