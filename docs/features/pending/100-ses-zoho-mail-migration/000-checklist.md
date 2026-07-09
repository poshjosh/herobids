1. Set up Zoho Mail for `openaidom.com`
- In Zoho, add the domain.
- Copy the DNS records Zoho gives you into Route 53:
  - domain verification record
  - MX records
  - DKIM record
- Create your mailboxes, for example:
  - `admin@openaidom.com`
  - `jane@openaidom.com`

2. Set up Amazon SES for sending
- In SES, verify `openaidom.com` as a domain identity.
- Enable DKIM and add the SES DKIM records to Route 53.
- If your AWS account is still in SES sandbox, request production access.

3. Add one SPF record and one DMARC record
- Important: only have one SPF record for the domain.
- Combine Zoho and SES into that one SPF record.
- Add a basic DMARC record too.

4. Test
- Send a test email from SES.
- Receive a test email in Zoho.
- Check that replies go to the Zoho mailbox you want.

Simple split:
- Zoho Mail = inboxes
- SES = app/system sending

If you want, I can give you the exact Route 53 record checklist to add for Zoho + SES.

Verification

Do this in this order:

1. Check DNS is live
- In Route 53, confirm your Zoho MX records, Zoho verification record, Zoho DKIM record, SES DKIM records, SPF record, and DMARC record are present.
- Wait until Zoho and SES both show the domain as verified.

2. Check Zoho Mail
- In Zoho, make sure `openaidom.com` is verified.
- Create a mailbox like `admin@openaidom.com`.
- Send a test email from your Gmail to `admin@openaidom.com`.
- Confirm it arrives in Zoho.

3. Check Amazon SES
- In SES, verify that the domain identity for `openaidom.com` is `Verified`.
- Make sure DKIM is passing.
- If SES says `sandbox`, request production access before relying on it.

4. Test sending
- Send a test email from SES using `admin@openaidom.com` or `alerts@openaidom.com` as the sender.
- Send it to your Gmail.
- Confirm it lands and is not marked as spam.

5. Test reply path
- Reply from Gmail to that SES email.
- Confirm the reply reaches your Zoho inbox.

If all 5 work, `openaidom.com` is ready.