# calendar-addon-jitsi

A Google Calendar conferencing add-on that creates a Jitsi Meet room when a
user adds a "Jitsi Meet" conference to an event.

- [Workspace add-ons overview](https://developers.google.com/workspace/add-ons/overview)
- [Conference solutions](https://developers.google.com/workspace/add-ons/calendar/conferencing/create-conference)

## Files

| File | Responsibility |
|---|---|
| `appsscript.json` | add-on manifest |
| `Config.gs` | deployment profiles and script properties |
| `Jwt.gs` | JWT signing (HS256 and RS256) |
| `JitsiDialIn.gs` | dial-in PIN and phone numbers |
| `Code.gs` | `createConference` entry point and `ConferenceData` assembly |
| `Tests.gs` | editor-runnable checks: `runSelfTest`, `listScriptProperties` |
| `checkin/` | the check-in web app — a **separate Apps Script project**, with its own README |

## Configuration

No secrets are stored in the source. Set them in the Apps Script editor under
**Project Settings → Script Properties**:

| Property | Required | Meaning |
|---|---|---|
| `DEPLOYMENT_MODE` | no | `SELF_HOSTED`, `JAAS` or `PUBLIC`. Default `SELF_HOSTED`. |
| `APP_ID` | `SELF_HOSTED`, `JAAS` | Application id shared with the Jitsi deployment. |
| `APP_SECRET` | `SELF_HOSTED` | Shared secret for HS256 (Prosody's `app_secret`). |
| `SELF_HOSTED_DOMAIN` | no | Default `jitsi.amarulasolutions.com`. |
| `JAAS_PRIVATE_KEY` | `JAAS` | PKCS#8 PEM private key for RS256. |
| `JAAS_KEY_ID` | `JAAS` | `"<app id>/<key id>"`. |
| `JAAS_TENANT` | `JAAS` | `"vpaas-magic-cookie-<uuid>"`. |
| `TOKEN_TTL_HOURS` | no | JWT lifetime. Default `720` (30 days). |
| `GRANT_MODERATOR` | no | `"false"` to omit the moderator claim. Default `true`. |
| `TOKEN_IDENTITY` | no | `"none"` or `"organizer"`. Default `"none"`. |
| `CHECKIN_URL` | `CHECKIN` | The check-in web app's `/exec` URL. Must be https. |
| `TICKET_SECRET` | `CHECKIN` | Shared with the check-in page. |
| `TICKET_TTL_HOURS` | no | Invitation lifetime. Default `720` (30 days). |
| `JITSI_DOMAIN` | no | Overrides the domain. Default `jitsi.amarulasolutions.com`. |

### Choosing a deployment

| | `SELF_HOSTED` | `JAAS` | `PUBLIC` | `CHECKIN` |
|---|---|---|---|---|
| Domain | `SELF_HOSTED_DOMAIN` | `8x8.vc` | `meet.jit.si` | `JITSI_DOMAIN` |
| Token | HS256, shared secret | RS256, RSA private key | none | **none — minted by the check-in page** |
| Dial-in | none | 8x8.vc mapper | `api.jitsi.net` | none |
| Holds the Jitsi secret | yes | yes | n/a | **no** |

`SELF_HOSTED` targets an install running token authentication
(`authentication = "token"` in Prosody, `anonymousdomain` on the client).

`CHECKIN` is the one to use if you want attendees to arrive with their own
names. The add-on mints a **room ticket** — which room, who booked it, what it
is called, and no identity — and the invitation links to the check-in web app
in `checkin/`. When somebody clicks, that page works out who they are and mints
a token naming them, giving moderator to the person the ticket says booked it.

Two things follow from that, and both are the point:

- **The add-on no longer holds the Jitsi signing secret.** It holds only
  `TICKET_SECRET`, so a compromised add-on cannot mint a Jitsi credential for
  an arbitrary room.
- **Nothing identifying sits in the invitation.** The ticket names no one, so
  it is harmless in an attendee's calendar or a forwarded email.

It is a second Apps Script project rather than part of this one, because it
holds the Jitsi signing secret and this project must not. Setting one up —
including the `TICKET_SECRET` that has to match on both sides — is documented
in [`checkin/README.md`](checkin/README.md).

`PUBLIC` mints no token. A token signed with your own secret authenticates
nothing on `meet.jit.si` — that service runs its own sign-in — so sending one
would only add a misleading query parameter.

> **`meet.jit.si` is a weak target today.** Anonymous room creation ended in
> August 2026, so the room creator must sign in and invitees wait for a
> moderator, and since October 2026 meetings are capped at 95 minutes.

### A note on the moderator claim

The token is baked into the invitation URL when the conference is created, and
every attendee receives that same URL. So `GRANT_MODERATOR=true` makes **every
invitee a moderator** — it does not mean "the organiser is the moderator".
That is usually what an internal deployment wants, because a room with no
moderator at all is unusable, but it is worth being deliberate about. Handing
moderator to the organiser alone requires a per-participant token, which
requires a redirector that mints one when the link is clicked.

### A note on participant identity

`TOKEN_IDENTITY` defaults to `"none"`, and that is not a placeholder default —
it is the only correct one for a shared invitation.

There is exactly one token per event and it travels in the join URL, so every
attendee presents the same identity to the Jitsi server. Filling in the
organiser's name and address therefore does **not** identify the organiser: it
presents every guest as the organiser. It also degrades badly, because when the
event has no display name to use the token carries an empty name and Jitsi falls
back to whatever display name that browser last used — which shows up as
participants appearing under someone else's name entirely.

`"none"` leaves the identity blank and lets Jitsi name each participant
individually. `"organizer"` is available for a room you know will be run by a
single host, and should be used deliberately.

A genuinely per-participant identity needs a token minted when the link is
clicked, which needs a redirector service between the invitation and the room.
An invitation URL cannot do it.

The **subject** is a different matter and *is* per-event: the event title is
sent as `#config.subject`, so the room shows the right meeting name without
anyone being misidentified.

## The conference icon

`conferenceSolution[].logoUrl` and `common.logoUrl` must point at an image
**hosted on Google infrastructure**, and the Marketplace review checklist
requires the URL to begin with `https://lh3.googleusercontent.com/`.

To set it: open the Cloud console → **APIs & Services** → **Google Workspace
Marketplace SDK** → **Store Listing** → **Graphics Assets**, and use the URL of
the **Application Icon 32x32**. `images/calendar-logo.png` (96x96, RGBA,
transparent) is the source asset if the listing needs one re-uploaded.

Both `logoUrl` fields currently hold a placeholder. Replace both with the same
store-listing URL. Note that Google caches the icon URL, and community reports
put propagation at roughly two to four days.

## Deployment

The project is plain Apps Script. To deploy with
[`clasp`](https://github.com/google/clasp), create `.clasp.json` pointing at
your script id:

```json
{ "scriptId": "<your script id>", "rootDir": "." }
```

then `clasp push`. The manifest must be named `appsscript.json` — Apps Script
does not recognise any other spelling, and `clasp` would push a misnamed file
as an ordinary script file, silently leaving the real manifest unchanged.

`urlFetchWhitelist` in the manifest lists every host the add-on fetches. It
requires `https://` URLs with a non-empty path.
