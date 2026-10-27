# School login and password emails

School account emails use an immediate Gmail sender. The hourly ICDD delivery task is not used for login links or password resets.

The connection requires one-time authorization by the Gmail account owner. ChatGPT's Gmail connection cannot be copied into a hosted application's environment. Never put a Gmail password, account token, or connection secret in GitHub or chat.

## Authorize the sender once

1. Sign in to Google Apps Script with **emmanuelnyame25@gmail.com**, the sender used for ICDD. Create a private project named **Revolt-X School Gmail Sender**.
2. Copy `integrations/gmail/Code.gs` into its code file. Enable the manifest in Project Settings and use `integrations/gmail/appsscript.json`.
3. Run `authorizeSender` and review Google's permission request. It requires sending email and identifying the sending account, without reading the inbox.
4. Deploy a web app that **executes as you** and is accessible to **Anyone**. Every send is protected by the generated high-entropy shared secret. Do not deploy it as the person accessing the app.
5. Copy the `/exec` web app URL. In Project Settings > Script properties, privately obtain `MAILER_SECRET`; do not print it in execution logs.
6. Configure the existing School Render service with `AUTH_EMAIL_PROVIDER=gmail`, `GMAIL_FROM_EMAIL` set to the authorizing account, `GMAIL_MAILER_URL` set to the `/exec` URL, and `GMAIL_MAILER_SECRET` set to the private property value. Set `PUBLIC_BASE_URL` to the live School origin.
7. On the Core OS service, enable `SCHOOL_ACCESS_EMAILS=true` after testing the School sender.

No Google Cloud client-secret project or SMTP password is required. Google applies Apps Script's account sending quotas. The sender project must remain authorized.

## What is sent

- Creating a School user or teacher sends a single-use password setup email to their registered address. Staff setup emails request a 30-minute token from Core OS.
- Resetting a staff password sends a new secure setup email to the address on the school account.
- Creating/changing the primary School administrator sends login instructions to that administrator.
- Generating an administrator reset link also sends it to the registered administrator address.
- Existing Core OS recovery emails use the immediate connection when Gmail is enabled.

Passwords are never included in these emails. Administrator-visible temporary passwords remain available for the existing manual handover process. Links are scoped to the correct school and do not change independent OS credentials.

The sender is separate from general School communications. Enabling account email does not resend old fee, report or parent-message backlog entries. Requests with uncertain acceptance require review; they are not automatically sent again.

`GET /api/system/auth-email/status` is a read-only status check requiring the existing system-log permission. It returns configuration readiness without credentials. Configuration alone does not prove inbox delivery.
