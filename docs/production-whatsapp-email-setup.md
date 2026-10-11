# Revolt-X School production WhatsApp and email setup

## WhatsApp production account

Revolt-X School supports the Meta WhatsApp Cloud API directly and can also use Twilio. Meta Cloud API is the preferred direct production setup.

1. In Meta Business Portfolio, add or create the organisation that will own the School messaging account.
2. Add the WhatsApp product to a Meta app and create/connect the WhatsApp Business Account.
3. Add and verify the production sending number. This must be a number controlled by the business and approved for WhatsApp Business use.
4. Create an approved utility template for school notices that may be sent outside the 24-hour customer-service window.
5. Create a permanent system-user access token with the required WhatsApp permissions. Do not store this token in GitHub or source code.
6. In the Render environment for `revolt-x-school`, configure:
   - `WHATSAPP_PROVIDER=meta`
   - `WHATSAPP_TOKEN=<secret token>`
   - `WHATSAPP_PHONE_NUMBER_ID=<Meta phone number id>`
   - `WHATSAPP_BUSINESS_ACCOUNT_ID=<Meta WABA id>`
   - `WHATSAPP_TEMPLATE_NAME=<approved template name>`
   - `WHATSAPP_TEMPLATE_LANGUAGE=en_GB` (or the approved template language)
   - `WHATSAPP_ALLOW_SESSION_MESSAGES=false` unless free-form replies inside the 24-hour customer-service window are intentionally enabled.
7. Redeploy, then use the School Communication Centre connection check before sending to real parents/staff.

Never paste the permanent access token into support messages, source control, screenshots or documentation.

## Web address / domain

The current Render addresses are free HTTPS web addresses and can be used at launch:

- Core OS: `https://revolt-x-os.onrender.com`
- School: `https://revolt-x-school.onrender.com`

Each School now receives a tenant-specific address such as:

- `https://revolt-x-school.onrender.com/s/grace-prep/login`
- `https://revolt-x-school.onrender.com/s/grace-prep/admin-login`

A free Render subdomain is suitable while the company is validating the product. A branded custom domain can be attached later without changing tenant IDs.

## Production email

Revolt-X School supports Brevo and Resend. For commercial mail, use a domain you own and authenticate it with SPF/DKIM. A free web subdomain does not provide free mailboxes for every employee.

Recommended startup setup:

1. Use Brevo's or Resend's free sending tier while volumes are low.
2. Verify a branded sender/domain before sending to parents or staff at scale.
3. Configure the Render environment using one provider only.

### Resend

- `EMAIL_PROVIDER=resend`
- `EMAIL_DELIVERY_MODE=production`
- `RESEND_API_KEY=<secret>`
- `RESEND_FROM_EMAIL=notifications@yourdomain`
- `EMAIL_REPLY_TO=support@yourdomain` (optional)

### Brevo

- `EMAIL_PROVIDER=brevo`
- `EMAIL_DELIVERY_MODE=production`
- `BREVO_API_KEY=<secret>`
- `BREVO_FROM_EMAIL=notifications@yourdomain`
- `BREVO_FROM_NAME=Revolt-X School`
- `EMAIL_REPLY_TO=support@yourdomain` (optional)

If individual staff mailboxes are required (for example `teacher@school.edu.gh`), those are mailbox accounts and are separate from transactional email delivery. They require an email-hosting provider or the school's existing Microsoft 365 / Google Workspace service.
