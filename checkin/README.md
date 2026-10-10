# Check-in page

The step between a calendar invitation and the Jitsi room.

A Calendar conferencing add-on runs once, when the organiser books the meeting,
and every attendee gets the same URL from then on. It cannot know who is
clicking. This web app sits in the click path instead: it verifies the ticket
the add-on put in the invitation, works out who is asking, and mints a Jitsi
token naming that person.

This is a **separate Apps Script project** from the add-on, deliberately. It
holds the Jitsi signing secret, which the add-on must never have.

## Script properties

| Property | Required | Meaning |
|---|---|---|
| `TICKET_SECRET` | yes | Shared with the add-on. Lets this page trust that a request names a real room booked through Calendar. Generate a random value. |
| `JITSI_APP_ID` | yes | Your Prosody `app_id`. |
| `JITSI_APP_SECRET` | yes | Your Prosody `app_secret`. **This is the secret the add-on no longer holds.** |
| `JITSI_DOMAIN` | no | Default `jitsi.amarulasolutions.com`. |
| `ALLOWED_DOMAIN` | no | Default `amarulasolutions.com`. Anyone outside it joins as a guest. |
| `TOKEN_TTL_HOURS` | no | Default `5`. The token is minted at click time, so it only has to outlive the meeting. |

## How the two projects fit together

Two Apps Script projects, and the split is the point:

```
add-on project    holds TICKET_SECRET          → can describe a room, cannot mint a Jitsi credential
check-in project  holds TICKET_SECRET and      → can mint a Jitsi credential for the room a ticket
                  JITSI_APP_SECRET                names, for the person who clicked
```

Neither can do the other's job. A compromise of the add-on yields the ability
to forge *tickets*, not *tokens*; the Jitsi signing key is not in that project
at all.

They never talk to each other directly. The add-on puts a link in an invitation
and the browser carries it to the check-in page — so no firewall rule, no
service-to-service credential, and no `urlFetchWhitelist` entry is needed.

The dependency runs one way only: **the add-on needs the check-in project, not
the reverse.** Deleting the check-in deployment breaks every join link; nothing
you do to the add-on breaks the check-in page.

## Setting it up from scratch

1. **Create a standalone Apps Script project.** In the editor: *File → New →
   Project*, or `clasp create-script --type standalone --title "Jitsi
   Check-in"`. Copy `Checkin.gs` and `appsscript.json` from this directory in.
2. **Set the script properties** from the table above. Generate `TICKET_SECRET`
   fresh — `openssl rand -base64 32` — rather than inventing one.
3. **Authorise it.** Run any function once from the editor and approve the
   prompt. A web app cannot serve until its owner has authorised it, and until
   then every request gets a Drive permission error rather than anything
   useful — which reads as a broken deployment rather than a missing
   authorisation.
4. **Deploy it as a web app** and copy the `/exec` URL. The `webapp` block in
   `appsscript.json` already sets `Execute as: Me` and `Who has access:
   Anyone`; `Anyone` is required, not incidental, since outside attendees have
   to be able to reach the page in order to be sent down the guest path.
5. **Point the add-on at it.** On the *add-on's* project — a different project,
   with its own properties — set:

   | Property | Value |
   |---|---|
   | `DEPLOYMENT_MODE` | `CHECKIN` |
   | `CHECKIN_URL` | the `/exec` URL from step 4 |
   | `TICKET_SECRET` | **byte-identical to this project's** |

6. **Verify** with `makeTestLink` here and `runSelfTest` there, then create a
   Calendar event and click the link.

Step 5 is where people lose time. Script properties are per-project, so setting
`TICKET_SECRET` here does nothing for the add-on, and the two values must match
exactly — a mismatch produces *"The ticket is not signed correctly"*, which
identifies neither which side is wrong nor that a mismatch is even the problem.
Both projects expose a `listScriptProperties` function that reports the secret
by length, so the two can be compared without anyone reading a key aloud.

**This project is versioned; the add-on's test deployment is not.** After any
change here, `clasp push` alone is not enough — the `/exec` URL keeps serving
the old version until you also run `clasp redeploy <deploymentId>`. Nothing
will look broken; it will simply behave as it did before your change.

## Deployment

**Deploy → New deployment → Web app**, or the `webapp` block in
`appsscript.json`, which is already set to:

```
Execute as:      Me
Who has access:  Anyone
```

"Anyone" is required, not incidental — outside attendees have to be able to
reach the page in order to be sent down the guest path.

## Test it before the add-on knows it exists

1. Run **`makeTestLink`** from the editor. It prints a room, a signed ticket,
   and a ready-to-click check-in link.
2. Open that link from a company account. You should land in the room as
   yourself, and be a moderator if you own the ticket.
3. Open it from a personal Google account. You should land in the same room
   with no name and no moderator rights.
4. Open **`?diag=1`** on the web app URL from both accounts. This is the check
   that decides whether the guest fallback can work at all — see below.

`makeNonOrganizerLink` signs a ticket owned by someone else, so you can confirm
that a non-organiser joins without moderator rights.

## Why joining takes a click

Apps Script serves every web app inside a sandboxed iframe whose permission
policy delegates a fixed list — accelerometer, autoplay, fullscreen, geolocation
and so on — from which **camera, microphone and display-capture are absent**. A
redirect, whether by meta refresh or by script, navigates that frame, so Jitsi
would load inside it unable to reach either device. The room looks fine and the
browser reports "permission not granted for camera and microphone", with no
prompt the user can accept.

The way on is therefore a link with `target="_top"`, which escapes the frame.
The sandbox grants `allow-top-navigation-by-user-activation` — the exact flag
that permits this from a click, and only from a click. That is why there is a
button, and why it cannot be turned back into an automatic redirect.

If that click ever stops working, the fallback is `target="_blank"` with
`rel="noopener"`: `allow-popups-to-escape-sandbox` is granted, so a new tab
also escapes. Less tidy than the same tab, but it has fewer moving parts.

## The identity assumption — measured, not assumed

`Session.getActiveUser().getEmail()` is what tells a company member from
everyone else. Google's documentation was ambiguous about a web app deployed
to **execute as me**: it lists that mode among contexts where the address is
unavailable, then carves out an exception for users in the same domain as the
script owner. It was not clear which applied.

Measured on the live deployment (`USER_DEPLOYING` + `ANYONE_ANONYMOUS`):

| Visitor | `getActiveUser().getEmail()` | Result |
|---|---|---|
| Signed-in company member | their address | own token; moderator if they booked it |
| Anonymous, or outside the domain | empty | guest link, no token |

The exception applies. The design works as drawn.

The practical consequence is worth stating plainly: **only the script owner
ever authorises anything.** Attendees never see a consent screen, nobody
generates a secret, and this is the entire reason the sandbox-iframe
workaround in the section above is worth tolerating.

It also means this is now a dependency on undocumented behaviour. If a
Workspace policy tightens, or the deployment is ever switched to
`USER_ACCESSING`, members would start resolving to empty and would **silently**
fall through to the guest path — a meeting where nobody has moderator and
everyone is prompted for a name. `?diag=1` exists to catch exactly that; it is
worth opening after any change to the deployment settings.

## Branding the consent prompt

Reading the visitor's identity needs a scope, and a scope needs a grant — so
each person authorises this page **once**, the first time they join, and is
never asked again. The page is otherwise invisible to attendees, who only ever
see a "Your meeting is ready" button.

The problem is what that one screen looks like. A script on Google's **default
GCP project** has no branding to draw on, so Google shows the generic developer
name:

```
Jitsi Check-in
Jitsi Check-in needs your permission to access your data on Google.
GoogleAppsScript                      ← this
```

`GoogleAppsScript` reads like a phishing page, and for anyone outside the
domain it may also carry an *unverified app* warning. Both are fixable, and
both are fixable the same way.

### What to do

1. **Create or choose a standard GCP project** in your organization. The org is
   required — an *Internal* consent screen is only offered for a project that
   belongs to one (check **IAM & Admin → Settings → Location**; if it is blank,
   the project is not in the org).
2. **Attach it** to this script: Apps Script editor → **Project Settings →
   Google Cloud Platform (GCP) Project → Change project** → enter the project
   number.
3. **Set the user type.** Cloud console → **Google Auth Platform → Audience →
   User type: Internal**. This bypasses verification entirely for accounts in
   your domain: no *unverified* warning, no 100-user cap, and only
   `amarulasolutions.com` accounts can authorise it — which is what you want.
   The old *OAuth consent screen → User type* location no longer exists; the
   setting moved under **Audience**.
4. **Fill in Branding** — app name, logo (`images/icon-128.png` works), support
   email. This is what replaces the `GoogleAppsScript` line.

### The step that breaks things quietly

**Changing the GCP project can invalidate the existing web app deployment.**
After step 2, redeploy and compare the `/exec` URL with the one recorded above:

- **Same URL** → nothing further to do.
- **Different URL** → update `CHECKIN_URL` on the add-on's project *before*
  anyone books another meeting.

That second case is the dangerous one. Invitations already sent keep working,
because they carry the old URL and the old deployment still resolves — so the
failure appears only on **newly created** events, days later, and looks like
the add-on has broken rather than a setting having changed.

### What this does not fix

Attendees from outside the domain. They never reach the consent screen in the
normal case — they resolve to an empty address and go straight to the guest
path — but if they ever are prompted, they will still see an unverified
warning, and the only cure is Google's full OAuth verification. Not worth
pursuing for an internal tool.
