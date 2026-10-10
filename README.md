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

### Choosing a deployment

| | `SELF_HOSTED` | `JAAS` | `PUBLIC` |
|---|---|---|---|
| Domain | `SELF_HOSTED_DOMAIN` | `8x8.vc` | `meet.jit.si` |
| Token | HS256, shared secret | RS256, RSA private key | none |
| Dial-in | none | 8x8.vc mapper | `api.jitsi.net` |

`SELF_HOSTED` targets an install running token authentication
(`authentication = "token"` in Prosody, `anonymousdomain` on the client).

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
