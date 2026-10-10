/**
 * Deployment configuration for the Jitsi Calendar add-on.
 *
 * No secrets live in this file or in git. Set them in the Apps Script editor
 * under Project Settings > Script Properties:
 *
 *   DEPLOYMENT_MODE     SELF_HOSTED | JAAS | PUBLIC | CHECKIN
 *                                                             (default SELF_HOSTED)
 *   APP_ID              application id, shared with the Jitsi deployment
 *   APP_SECRET          shared secret for HS256          (SELF_HOSTED only)
 *   SELF_HOSTED_DOMAIN  overrides the default domain     (SELF_HOSTED only)
 *   JAAS_PRIVATE_KEY    PKCS#8 PEM private key for RS256 (JAAS only)
 *   JAAS_KEY_ID         "<app id>/<key id>"              (JAAS only)
 *   JAAS_TENANT         "vpaas-magic-cookie-<uuid>"      (JAAS only)
 *   CHECKIN_URL         the check-in web app's /exec URL (CHECKIN only)
 *   TICKET_SECRET       shared with the check-in page    (CHECKIN only)
 *   JITSI_DOMAIN        overrides the default domain     (CHECKIN only)
 *   TICKET_TTL_HOURS    invitation lifetime, default 720 (CHECKIN only)
 *   TOKEN_TTL_HOURS     JWT lifetime, default 720        (30 days)
 *   GRANT_MODERATOR     "true" to put moderator in the token (default true)
 *   TOKEN_IDENTITY      "none" or "organizer"            (default none)
 */

/** Default domain of the self-hosted deployment. */
const DEFAULT_SELF_HOSTED_DOMAIN = 'jitsi.amarulasolutions.com';

/**
 * Conference solution id. Must match `addOns.calendar.conferenceSolution[].id`
 * in appsscript.json, and must never change once chosen: existing Calendar
 * events already reference it.
 */
const CONFERENCE_SOLUTION_ID = '1';

/** Dial-in gateway flavours. A self-hosted install without Jigasi has none. */
const DIAL_IN_JITSI_NET = 'JITSI_NET';
const DIAL_IN_JAAS = 'JAAS';

const DEFAULT_TOKEN_TTL_HOURS = 720;

/**
 * Resolves the deployment selected by the DEPLOYMENT_MODE script property.
 *
 * The three profiles differ in more than domain: JaaS signs RS256 with an RSA
 * private key and uses a fixed `iss`/`aud`, while a self-hosted install signs
 * HS256 with the shared secret configured in Prosody. See Jwt.gs.
 *
 * @return {Object} the active deployment profile.
 */
function getDeployment() {
  const mode = getProperty_('DEPLOYMENT_MODE') || 'SELF_HOSTED';

  switch (mode) {
    case 'SELF_HOSTED':
      return {
        mode: mode,
        domain: domainOrThrow_(
            getProperty_('SELF_HOSTED_DOMAIN') || DEFAULT_SELF_HOSTED_DOMAIN,
            'SELF_HOSTED_DOMAIN'),
        jwtAlgorithm: 'HS256',
        appId: requiredProperty_('APP_ID'),
        sharedSecret: requiredProperty_('APP_SECRET'),
        dialIn: null,
      };

    case 'JAAS':
      return {
        mode: mode,
        domain: '8x8.vc',
        jwtAlgorithm: 'RS256',
        appId: requiredProperty_('APP_ID'),
        privateKey: requiredProperty_('JAAS_PRIVATE_KEY'),
        keyId: requiredProperty_('JAAS_KEY_ID'),
        tenant: requiredProperty_('JAAS_TENANT'),
        dialIn: DIAL_IN_JAAS,
      };

    case 'PUBLIC':
      return {
        mode: mode,
        domain: 'meet.jit.si',
        // A token signed with our own secret authenticates nothing here:
        // meet.jit.si runs its own sign-in service and is not configured with
        // our app id. Minting one would only add a misleading query param.
        jwtAlgorithm: null,
        appId: null,
        dialIn: DIAL_IN_JITSI_NET,
      };

    // The add-on stops minting Jitsi tokens here. It mints a ticket naming the
    // room, and the check-in page mints a token for whoever clicks the link.
    // The consequence worth noticing: the Jitsi signing secret is not in this
    // project at all, so a compromise of the add-on cannot produce a Jitsi
    // credential for an arbitrary room.
    case 'CHECKIN':
      return {
        mode: mode,
        domain: domainOrThrow_(
            getProperty_('JITSI_DOMAIN') || DEFAULT_SELF_HOSTED_DOMAIN,
            'JITSI_DOMAIN'),
        jwtAlgorithm: null,
        appId: null,
        checkinUrl: httpsUrlOrThrow_(
            requiredProperty_('CHECKIN_URL'), 'CHECKIN_URL'),
        ticketSecret: requiredProperty_('TICKET_SECRET'),
        dialIn: null,
      };

    default:
      throw new Error('Unknown DEPLOYMENT_MODE "' + mode +
          '". Expected SELF_HOSTED, JAAS, PUBLIC or CHECKIN.');
  }
}

/**
 * The MUC service for the deployment. JaaS tenants are namespaced under the
 * tenant id; everything else is a plain `conference.<domain>`.
 *
 * @param {Object} deployment as returned by getDeployment().
 * @return {string}
 */
function mucHost(deployment) {
  return deployment.mode === 'JAAS'
      ? 'conference.' + deployment.tenant + '.' + deployment.domain
      : 'conference.' + deployment.domain;
}

/**
 * JaaS addresses rooms as `<tenant>/<room>` on 8x8.vc; every other deployment
 * uses a bare `<room>` path segment.
 *
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @return {string}
 */
function roomPath(deployment, roomName) {
  return deployment.mode === 'JAAS'
      ? deployment.tenant + '/' + roomName
      : roomName;
}

/**
 * JWT lifetime in hours.
 *
 * The token is baked into the invitation URL when the conference is created,
 * so it has to outlive the gap between "organiser adds a conference" and
 * "invitee clicks the link". A short TTL breaks the invite; an unbounded one
 * leaves a bearer credential in every attendee's calendar for ever. 30 days is
 * the deliberate middle, and it is configurable.
 *
 * @return {number}
 */
function getTokenTtlHours() {
  const raw = getProperty_('TOKEN_TTL_HOURS');
  if (!raw) {
    return DEFAULT_TOKEN_TTL_HOURS;
  }

  const hours = Number(raw);
  if (!isFinite(hours) || hours <= 0) {
    throw new Error('TOKEN_TTL_HOURS must be a positive number, got "' + raw + '".');
  }
  return hours;
}

/**
 * Whether the minted token grants moderator rights.
 *
 * WARNING: the token is shared by everyone who receives the invitation, so
 * turning this on makes every invitee a moderator. That is usually what an
 * internal deployment wants -- a room with no moderator at all is unusable --
 * but it is not the same thing as "the organiser is the moderator". Handing
 * moderator to the organiser alone needs a per-participant token, which in
 * turn needs a redirector that mints one at click time; an invitation URL
 * cannot do it.
 *
 * @return {boolean}
 */
function grantsModerator() {
  return (getProperty_('GRANT_MODERATOR') || 'true').toLowerCase() !== 'false';
}

/**
 * Whether the minted token carries a participant identity.
 *
 * Defaults to 'none', and that default matters. There is exactly one token per
 * invitation and it travels in the URL, so every attendee joins with whatever
 * identity it carries. Naming the organiser therefore does not identify the
 * organiser -- it makes every guest appear to be the organiser, which is
 * impersonation and wrong for anything but a single-host meeting. It also
 * breaks down entirely when the event has no display name to use, because the
 * token then carries an empty name and Jitsi falls back to whatever display
 * name that browser last used.
 *
 * 'none' leaves the identity blank and lets Jitsi name each participant
 * individually, which is what the add-on did before.
 *
 * @return {string} 'none' or 'organizer'.
 */
function getTokenIdentity() {
  const raw = (getProperty_('TOKEN_IDENTITY') || 'none').toLowerCase();
  if (raw !== 'none' && raw !== 'organizer') {
    throw new Error('TOKEN_IDENTITY must be "none" or "organizer", got "' +
        raw + '".');
  }
  return raw;
}

/**
 * How long a room ticket stays valid, in hours.
 *
 * This is the lifetime of the invitation link rather than of any credential:
 * a ticket carries no identity, so it can afford to be generous where a token
 * could not. It only has to outlive the gap between booking a meeting and
 * somebody clicking the link.
 *
 * @return {number}
 */
function getTicketTtlHours() {
  const raw = getProperty_('TICKET_TTL_HOURS');
  if (!raw) {
    return DEFAULT_TOKEN_TTL_HOURS;
  }

  const hours = Number(raw);
  if (!isFinite(hours) || hours <= 0) {
    throw new Error('TICKET_TTL_HOURS must be a positive number, got "' + raw + '".');
  }
  return hours;
}

function getProperty_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function requiredProperty_(name) {
  const value = getProperty_(name);
  if (!value) {
    throw new Error('Script property ' + name + ' is not set. See Config.gs ' +
        'for the full list of properties this add-on reads.');
  }
  return value;
}

/**
 * A URL that will end up in an invitation, so it has to be https. An http://
 * or mistyped value here would put a broken or downgraded link in front of
 * every attendee, and it would look like a working meeting until they clicked.
 *
 * @param {string} value the configured URL.
 * @param {string} name the property name, for the error message.
 * @return {string}
 */
function httpsUrlOrThrow_(value, name) {
  if (typeof value !== 'string' || value.indexOf('https://') !== 0) {
    throw new Error(name + ' must be an https URL, got "' + value + '".');
  }
  return value;
}

function domainOrThrow_(value, name) {
  if (typeof value !== 'string' || !value ||
      value.indexOf('/') >= 0 || value.indexOf('.') < 0) {
    throw new Error(name + ' must be a bare domain such as ' +
        '"jitsi.example.com", got "' + value + '".');
  }
  return value;
}
