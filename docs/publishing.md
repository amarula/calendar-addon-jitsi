# Publishing

Everything on this page happens in the Google Cloud console, not in this
repository, and none of it can be recovered from the code. It is written down
because the console splits related settings across pages that look alike, and
because two of them are one-way doors.

## Where things are

| Setting | Page |
|---|---|
| Listing name, description, screenshots, icons | Marketplace SDK → **Store Listing** |
| Visibility, deployment ID, OAuth scopes | Marketplace SDK → **App Configuration** |
| Consent screen and branding for the check-in web app | a *different* GCP project — see [`checkin/README.md`](../checkin/README.md) |

**The way into the SDK is the `Manage` button** on the Google Workspace
Marketplace SDK product page. Clicking the API in the enabled-APIs list gives
you the generic *Overview / Metrics / Quotas* page, which has no configuration
on it at all — a dead end that looks like the right place.

`Store Listing` and `App Configuration` are **separate pages**, not tabs beside
each other, despite being described that way in places.

## The deployment ID is the whole association

App Configuration → **App Integrations → Google Workspace add-on** holds a
deployment ID. That single string is the entire link between the listing and
your Apps Script project; there is nothing else to inspect or keep in sync.

Verify it from the repository:

```
clasp list-deployments
```

If the ID appears in the list, the listing serves that project. If it appears
in none, the listing points at a deployment that no longer exists — and the
add-on's code will never run, which looks like the add-on simply being broken.

**The version number is what tells you which code is live.** A deployment ID
never changes; the version behind it moves on each redeploy. So:

| ID found | Version | Meaning |
|---|---|---|
| yes | current | live and up to date |
| yes | older | serving stale code — redeploy |
| nowhere | — | broken; the listing points at nothing |

## Shipping a change

```
clasp push                              # moves @HEAD only
clasp create-version "description"      # an immutable snapshot of it
clasp redeploy <deployment id>          # users get it here
```

**`clasp push` alone changes nothing anyone can see.** This is the most
confusing part of the process: it looks like a deploy, reports success, and
leaves the live version untouched. The published add-on serves the version its
deployment points at, and only `redeploy` moves that.

Existing Calendar events are unaffected either way — they keep the conference
data created when they were last edited.

## One-way doors

**App visibility.** Public, Private or Unlisted — chosen once and saved, and
per Google's documentation *"you can't change your selection later."* Check
what it currently reads before touching anything on that page.

Choosing Private restricts the app to your Workspace domain and skips the
public review process, which is where most of the strict requirements live —
the `lh3.googleusercontent.com` prefix rule, matching the listing icon, the
trademark rules.

**OAuth verification.** Once an app has been used by anyone outside your
domain, removing the "unverified" warning requires Google's full verification
process. For an internal tool, keep it that way instead.

## The conference icon

`conferenceSolution[].logoUrl` and `common.logoUrl` must point at an image
**hosted on Google infrastructure**, and the review checklist is more specific:
the URL must begin with `https://lh3.googleusercontent.com/`.

The supported way to get one is to upload the icon as the listing's
**Application Icon 32×32** and copy the URL it returns. The PNGs in
[`images/`](../images) are generated from `images/jitsi-logo.svg` at 32, 48, 96
and 128 px.

Two traps:

- **A Google-hosted URL is not automatically a working one.** The original
  icon here was a legacy Google Photos album link on `lh3.googleusercontent.com`
  that began returning HTTP 403 when Google stopped serving unauthenticated
  hotlinks to that path form. Same hostname, dead image.
- **Google caches the icon URL** and documents no TTL. Community reports sit
  around two to four days. Changing the URL is the reliable way to force a
  refresh. The icon on *created events* reads the manifest and updates almost
  immediately; the one in the *conference picker* reads Google's cached copy of
  the listing and does not.

## Scopes and admin installs

For a domain-wide install, the admin consents to the app's scopes on behalf of
everyone, and users get no prompt at all. That only works if the scopes are
declared in **App Configuration → OAuth scopes** — the listing is where the
admin's consent reads them from, and the manifest is not visible to the
Marketplace.

If the list there is empty or incomplete, every user is prompted individually
no matter how the app is distributed.

- **Removing** a scope needs no re-grant.
- **Adding** one later sets the app to *Partially Granted*, requires the admin
  to grant it **manually** in the Admin console, and Google sends no
  notification. Calls using the new scope return 403 until someone notices.

## Test deployments

A test deployment is a separate install from the published add-on, even when
both point at the same code. Installing one alongside the published app gives
users two entries in Calendar's picker — so rename the test copy's
`conferenceSolution[].name` (for example `Jitsi Meet (test)`) to tell them
apart.

Install and uninstall from **Deploy → Test deployments** in the Apps Script
editor. *Manage deployments* is a different dialog, for deployment IDs and
versions.

Uninstalling affects only the account doing it. It does not touch the listing,
the deployment, or anyone else.
