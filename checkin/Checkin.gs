/**
 * Check-in page: the step between a calendar invitation and the Jitsi room.
 *
 * The calendar add-on cannot know who is clicking its link. It runs once, when
 * the organiser books the conference, and every attendee receives the same URL
 * from then on. This web app sits in the click path instead: it verifies the
 * ticket the add-on put in the invitation, works out who is asking, and mints
 * a Jitsi token naming that person.
 *
 * Two secrets, deliberately held by different parties:
 *
 *   TICKET_SECRET     shared with the add-on. Lets this page trust that a
 *                     request names a real room booked through Calendar.
 *   JITSI_APP_SECRET  the Jitsi signing key. Held only here, never by the
 *                     add-on, so a compromise of the Apps Script add-on
 *                     cannot mint Jitsi credentials for arbitrary rooms.
 *
 * Deploy as a web app with "Execute as: Me" and "Who has access: Anyone".
 */

const PROP_TICKET_SECRET = 'TICKET_SECRET';
const PROP_JITSI_APP_ID = 'JITSI_APP_ID';
const PROP_JITSI_APP_SECRET = 'JITSI_APP_SECRET';
const PROP_JITSI_DOMAIN = 'JITSI_DOMAIN';
const PROP_ALLOWED_DOMAIN = 'ALLOWED_DOMAIN';
const PROP_TOKEN_TTL_HOURS = 'TOKEN_TTL_HOURS';

const DEFAULT_JITSI_DOMAIN = 'jitsi.amarulasolutions.com';
const DEFAULT_ALLOWED_DOMAIN = 'amarulasolutions.com';
const DEFAULT_TOKEN_TTL_HOURS = 5;

/** Distinguishes a room ticket from any other token this secret might sign. */
const TICKET_PURPOSE = 'room-ticket';

/**
 * Every request to the check-in page.
 *
 * @param {Object} e the Apps Script event, carrying the query parameters.
 * @return {HtmlOutput}
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  // A browser-openable view of what the server sees for this visitor. This is
  // the check that decides whether the guest fallback can work at all, so it
  // is worth being able to open from any account, inside or outside.
  if (params.diag) {
    return diagnosticPage_();
  }

  let ticket;
  try {
    ticket = verifyTicket_(params.g);
  } catch (err) {
    return messagePage_('This link cannot be used', err.message);
  }

  const email = activeEmail_();

  // Anyone we cannot name goes in as a guest: no identity, no moderator. This
  // is the branch for people outside the company, and for anyone whose Google
  // session we cannot read.
  if (!isAllowed_(email)) {
    console.log('guest join: room=%s resolved=%s', ticket.room, email || '(none)');
    return redirectTo_(guestUrl_(ticket));
  }

  console.log('member join: room=%s user=%s', ticket.room, email);
  return redirectTo_(memberUrl_(ticket, email));
}

/* ------------------------------------------------------------------ *
 * Tickets
 * ------------------------------------------------------------------ */

/**
 * Verifies a room ticket and returns its claims.
 *
 * The ticket carries no identity, only the meeting: which room, who booked it,
 * what it is called. That is why it is safe to leave sitting in an invitation
 * for weeks. Identity enters separately, at click time.
 *
 * @param {string} token the ticket from the query string.
 * @return {Object} the verified claims.
 */
function verifyTicket_(token) {
  if (!token) {
    throw new Error('No ticket in the link.');
  }

  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new Error('The ticket is malformed.');
  }

  const expected = sign_(parts[0] + '.' + parts[1], config_().ticketSecret);
  if (expected !== parts[2]) {
    throw new Error('The ticket is not signed correctly.');
  }

  const claims = JSON.parse(base64UrlDecode_(parts[1]));

  if (claims.purpose !== TICKET_PURPOSE) {
    throw new Error('That is not a room ticket.');
  }
  if (!claims.room) {
    throw new Error('The ticket names no room.');
  }
  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('This invitation has expired.');
  }

  return claims;
}

/**
 * Mints a room ticket. Used by the tests here, and mirrored by the calendar
 * add-on, which is the real issuer.
 *
 * @param {string} room the bare room name.
 * @param {string} organizer the booking organiser's email.
 * @param {string} subject the meeting title.
 * @param {number} ttlHours how long the ticket stays valid.
 * @return {string} the signed ticket.
 */
function issueTicket(room, organizer, subject, ttlHours) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    room: room,
    organizer: organizer,
    subject: subject,
    purpose: TICKET_PURPOSE,
    exp: now + Math.round((ttlHours || 720) * 3600),
  };
  const signingInput = base64Url_({alg: 'HS256', typ: 'JWT'}) + '.' +
      base64Url_(claims);
  return signingInput + '.' + sign_(signingInput, config_().ticketSecret);
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The email of the person making the request, or '' when we cannot have it.
 *
 * An empty result is a normal outcome, not a failure: it is what sends the
 * visitor down the guest path.
 *
 * @return {string}
 */
function activeEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (err) {
    console.log('could not read the active user: %s', err);
    return '';
  }
}

/**
 * @param {string} email a resolved address, possibly empty.
 * @return {boolean} whether this person is a company member.
 */
function isAllowed_(email) {
  if (!email || email.indexOf('@') < 0) {
    return false;
  }
  const domain = email.split('@').pop().toLowerCase();
  return domain === config_().allowedDomain.toLowerCase();
}

/**
 * A display name for a member.
 *
 * Derived from the address, because Session gives us only the email. A proper
 * name would mean reading the Workspace directory, which needs the Directory
 * API and a wider scope than this page is worth.
 *
 * @param {string} email a company address.
 * @return {string}
 */
function displayNameFor_(email) {
  return email.split('@')[0];
}

/* ------------------------------------------------------------------ *
 * Join URLs
 * ------------------------------------------------------------------ */

/**
 * The join URL for a named member.
 *
 * @param {Object} ticket verified ticket claims.
 * @param {string} email the member's address.
 * @return {string}
 */
function memberUrl_(ticket, email) {
  const cfg = config_();
  const token = mintToken_(cfg, ticket, email);
  return 'https://' + cfg.domain + '/' + ticket.room +
      '?jwt=' + encodeURIComponent(token) +
      subjectFragment_(ticket);
}

/**
 * The join URL for a guest: a plain room link with no token.
 *
 * Jitsi routes a visitor with no token to the anonymous domain configured on
 * the server (currently guest.jitsi.amarulasolutions.com), so there is nothing
 * to construct here. Guests arrive without a name and without moderator.
 *
 * @param {Object} ticket verified ticket claims.
 * @return {string}
 */
function guestUrl_(ticket) {
  return 'https://' + config_().domain + '/' + ticket.room +
      subjectFragment_(ticket);
}

/**
 * The subject travels in the URL fragment. It comes from the verified ticket,
 * never from a query parameter, so it cannot be tampered with -- which matters
 * because `config.subject` sets the subject for the whole room.
 *
 * @param {Object} ticket verified ticket claims.
 * @return {string}
 */
function subjectFragment_(ticket) {
  return ticket.subject
      ? '#config.subject=' + encodeURIComponent(ticket.subject)
      : '';
}

/**
 * Mints the Jitsi token for one person.
 *
 * @param {Object} cfg resolved configuration.
 * @param {Object} ticket verified ticket claims.
 * @param {string} email the member's address.
 * @return {string} a signed JWT.
 */
function mintToken_(cfg, ticket, email) {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    aud: cfg.appId,
    iss: cfg.appId,
    sub: cfg.domain,
    room: ticket.room,
    nbf: now,
    exp: now + Math.round(cfg.ttlHours * 3600),
    context: {
      user: {
        id: email,
        name: displayNameFor_(email),
        email: email,
        avatar: '',
        // Only the person who booked the meeting moderates it. Everyone else
        // joins as a participant.
        moderator: email.toLowerCase() ===
            String(ticket.organizer || '').toLowerCase(),
      },
    },
  };

  const signingInput = base64Url_({alg: 'HS256', typ: 'JWT'}) + '.' +
      base64Url_(payload);
  return signingInput + '.' + sign_(signingInput, cfg.appSecret);
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

/**
 * Offers the way on to Jitsi.
 *
 * This is a link the visitor clicks rather than an automatic redirect, and the
 * reason is not stylistic. Apps Script serves every web app inside a sandboxed
 * iframe whose permission policy delegates a fixed list of features --
 * accelerometer, autoplay, fullscreen, geolocation and so on -- from which
 * camera, microphone and display-capture are absent. A redirect, whether by
 * meta refresh or by script, navigates that iframe, so Jitsi would load inside
 * a frame that is not permitted to touch the camera or microphone, and no
 * amount of user consent could override it. The symptom is "permission not
 * granted for camera and microphone" in a room that otherwise looks fine.
 *
 * `target="_top"` escapes the frame and loads Jitsi as a top-level document
 * with its normal permissions. The sandbox grants
 * `allow-top-navigation-by-user-activation`, which is exactly the flag that
 * permits this from a click -- and only from a click, which is why this cannot
 * be automated away. Do not "simplify" this back into a redirect.
 *
 * @param {string} url where to send them.
 * @return {HtmlOutput}
 */
function redirectTo_(url) {
  const safe = escapeHtml_(url);
  return HtmlService.createHtmlOutput(
      '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Join the meeting</title>' +
      '<style>' +
      'body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;' +
      'display:grid;place-items:center;min-height:100vh;background:#f5f7fa;' +
      'color:#12171f}' +
      'main{text-align:center;padding:2rem;max-width:26rem}' +
      'h1{font-size:1.25rem;margin:0}' +
      'p{color:#59636f;margin:.6rem 0 0}' +
      'a{display:inline-block;margin-top:1.5rem;padding:.85rem 1.9rem;' +
      'background:#1a5fb4;color:#fff;border-radius:6px;text-decoration:none;' +
      'font-weight:600}' +
      'a:focus-visible{outline:3px solid #1a5fb4;outline-offset:3px}' +
      '</style>' +
      '<main>' +
      '<h1>Your meeting is ready</h1>' +
      '<p>Jitsi opens in this tab, and your browser will ask for the camera ' +
      'and microphone.</p>' +
      '<a href="' + safe + '" target="_top" rel="noopener">' +
      'Join the meeting</a>' +
      '</main>');
}

/**
 * @param {string} title heading text.
 * @param {string} detail explanation.
 * @return {HtmlOutput}
 */
function messagePage_(title, detail) {
  return HtmlService.createHtmlOutput(
      '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + escapeHtml_(title) + '</title>' +
      '<div style="font:16px/1.5 system-ui;padding:2rem;max-width:34rem">' +
      '<h1 style="font-size:1.25rem">' + escapeHtml_(title) + '</h1>' +
      '<p>' + escapeHtml_(detail) + '</p>' +
      '<p>Ask the person who invited you for a new link.</p></div>');
}

/**
 * Shows what the server can actually see about the visitor.
 *
 * This exists to answer one question before anything is built on top of it:
 * does Google hand us the address of a company member, and does it stay silent
 * for everyone else? Open this from a company account and from a personal one
 * and compare.
 *
 * @return {HtmlOutput}
 */
function diagnosticPage_() {
  // Each probe runs independently. A diagnostic page that dies on the first
  // surprise is useless at exactly the moment it is needed, and some of these
  // depend on properties that may not be set yet.
  const probes = [
    ['getActiveUser().getEmail()', () => activeEmail_() || '(empty)'],
    ['treated as', () => isAllowed_(activeEmail_()) ? 'company member' : 'guest'],
    ['allowed domain', () => config_().allowedDomain],
    ['getTemporaryActiveUserKey()', () => Session.getTemporaryActiveUserKey() || '(empty)'],
    ['effective (owner) user', () => Session.getEffectiveUser().getEmail() || '(empty)'],
    ['script url', () => ScriptApp.getService().getUrl() || '(none)'],
  ];

  const rows = probes.map(probe => [probe[0], runProbe_(probe[1])]);

  const body = rows.map(row =>
      '<tr><th style="text-align:left;padding:.4rem 1rem .4rem 0;' +
      'font-weight:600;white-space:nowrap">' + escapeHtml_(row[0]) + '</th>' +
      '<td style="padding:.4rem 0;font-family:ui-monospace,monospace">' +
      escapeHtml_(String(row[1])) + '</td></tr>').join('');

  return HtmlService.createHtmlOutput(
      '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Check-in diagnostics</title>' +
      '<div style="font:16px/1.5 system-ui;padding:2rem;max-width:44rem">' +
      '<h1 style="font-size:1.25rem">Check-in diagnostics</h1>' +
      '<p>Open this page from a company account and from a personal one. ' +
      'If the second shows an empty address, the guest fallback works.</p>' +
      '<table style="border-collapse:collapse">' + body + '</table>' +
      '</div>');
}

/**
 * Runs one diagnostic probe, reporting a failure instead of propagating it.
 *
 * @param {function(): string} probe the value to read.
 * @return {string}
 */
function runProbe_(probe) {
  try {
    return String(probe());
  } catch (err) {
    return 'ERROR: ' + err.message;
  }
}

function escapeHtml_(text) {
  return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * @return {Object} resolved configuration, secrets included.
 */
function config_() {
  return {
    ticketSecret: requiredProperty_(PROP_TICKET_SECRET),
    appId: requiredProperty_(PROP_JITSI_APP_ID),
    appSecret: requiredProperty_(PROP_JITSI_APP_SECRET),
    domain: getProperty_(PROP_JITSI_DOMAIN) || DEFAULT_JITSI_DOMAIN,
    allowedDomain: getProperty_(PROP_ALLOWED_DOMAIN) || DEFAULT_ALLOWED_DOMAIN,
    ttlHours: Number(getProperty_(PROP_TOKEN_TTL_HOURS)) || DEFAULT_TOKEN_TTL_HOURS,
  };
}

function getProperty_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function requiredProperty_(name) {
  const value = getProperty_(name);
  if (!value) {
    throw new Error('Script property ' + name + ' is not set.');
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Crypto helpers
 * ------------------------------------------------------------------ */

function sign_(signingInput, secret) {
  return base64UrlBytes_(Utilities.computeHmacSha256Signature(
      signingInput, secret, Utilities.Charset.UTF_8));
}

function base64Url_(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8)
      .replace(/=+$/, '');
}

function base64UrlBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function base64UrlDecode_(text) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString();
}

/* ------------------------------------------------------------------ *
 * Editor helpers
 * ------------------------------------------------------------------ */

/**
 * Prints a ready-to-click check-in link for a throwaway room, so the page can
 * be exercised before the calendar add-on knows it exists.
 */
function makeTestLink() {
  const owner = Session.getEffectiveUser().getEmail();
  const room = 'checkin-test-' + Utilities.getUuid().slice(0, 8);
  const ticket = issueTicket(room, owner, 'Check-in test', 2);
  const url = ScriptApp.getService().getUrl() + '?g=' + encodeURIComponent(ticket);

  console.log('room    : ' + room);
  console.log('ticket  : ' + ticket);
  console.log('link    : ' + url);
  console.log('as guest: ' + guestUrl_({room: room, subject: 'Check-in test'}));
  return url;
}

/**
 * Prints the same link signed for a different organiser, so you can confirm
 * that a non-organiser joins without moderator rights.
 */
function makeNonOrganizerLink() {
  const room = 'checkin-test-' + Utilities.getUuid().slice(0, 8);
  const ticket = issueTicket(room, 'someone.else@' + config_().allowedDomain,
      'Not mine', 2);
  const url = ScriptApp.getService().getUrl() + '?g=' + encodeURIComponent(ticket);
  console.log('room : ' + room);
  console.log('link : ' + url);
  return url;
}
