# Gmail connection

Formwork reads job-search mail and suggests application associations, status
updates and sender contacts. You review each change. It has no mail-sending
endpoint and requests only Gmail read access.

1. Create your own Google Cloud project, enable Gmail API, and create a **Web
   application** OAuth client. Configure its consent screen and, if using testing
   mode, add your account as a test user.
2. Register the exact callback URI shown in **Settings → Gmail connection →
   Google OAuth setup**. Google requires a public DNS hostname with HTTPS, or a
   localhost exception. `.internal` hostnames and non-loopback IPs are rejected.
3. Open Formwork at the callback's host, save the client ID and secret, then press
   **Connect Google** and grant consent. The callback must return to the same
   browser that started the connection.

Google's [OAuth setup and redirect validation guide](https://developers.google.com/identity/protocols/oauth2/web-server)
explains the client configuration and consent requirements. OAuth client registration and account consent remain your actions;
installing Formwork does not authorize access to your mailbox.

After connecting, open **Job search → Job-search inbox** and choose **Sync Gmail
now**. Initial synchronization searches the last 90 days for application,
interview, recruiting and job-offer terms. A batch processes one page, preserving
a continuation cursor when more remain; **Sync next batch** continues it. Optional
15-minute automatic sync is enabled in Settings and processes pending pages once
per minute. This is job-search mail discovery, not a complete email client.

Synchronization uses Gmail's incremental history and resynchronizes the job-mail
archive if its history cursor expires. Pages are committed only after their
message reads succeed; retried message IDs do not duplicate local records.
Deleted messages are marked unavailable. See Google's
[synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync).
Requests select IDs, dates, headers and snippets; attachments and full bodies are
not retained. Gmail can evaluate body-only keyword matches using an exact
Message-ID lookup. [Partial responses](https://developers.google.com/workspace/gmail/api/guides/performance)
keep unneeded content out of the response.

Choose an application and optionally a new status before **Link reviewed
message**. Company matches and status phrases are suggestions; no status is
preselected. **Import sender contact** records the message provenance and refuses
no-reply addresses. It does not establish that a sender really works for an
employer, guess a role, or send them anything.

Tokens and client configuration live in `STATE_DIR/connections/google.json`
(mode 600, directory 700). Tokens and secrets are excluded from ordinary settings
and connection responses; callback query strings are redacted in access logs.
The SQLite database and its journal files are restricted to the service user.
Back up the state directory privately if you want to retain the connection.

**Disconnect Google** attempts revocation and always removes local tokens,
pending authorization and cached messages. Reviewed application history and
imported contacts remain. If revocation cannot reach Google, the UI tells you to
remove the app in your Google Account permissions. Expired/revoked grants produce
a visible reconnect error.

Calendar synchronization is separate work and is not included in this Gmail
connection yet. Live mailbox verification requires completing your own OAuth
setup; automated tests use fixture credentials and responses.

## Calendar

Enable Google Calendar API in the same Google Cloud project. In Job search,
open **Google Calendar → Connect calendar** to grant the additional calendar
permission. Use the same callback host as the Gmail connection. Gmail-only
consent does not enable calendar reads or writes.

**Sync Google Calendar** reads the primary calendar in batches. Continue with
**Read next calendar batch** until complete. Select an application beside a timed
event and press **Import reviewed schedule** to create or update its interview.
For a recurring series, choose a date range (at most one year), press **Show
occurrences**, and import the individual occurrence. Additional pages use **More
occurrences**. All-day dates do not supply an interview time.

**Export to Google Calendar** on an interview creates or updates a personal event
after confirmation. It exports company, interview round, time and location;
preparation notes and contact addresses stay local. The operation adds no guests.
Retries reuse the event ID. If someone edits the exported event in Google,
refresh the calendar and import the reviewed change before exporting again.
Events originally imported from Google should be edited at their source.

Cancellation updates are applied to interviews only when you import the reviewed
cancellation. Neither a sync nor a disconnect deletes your interview history.
