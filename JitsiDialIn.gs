/**
 * Dial-in details for deployments that have a PSTN gateway.
 *
 * A self-hosted install only offers this if Jigasi is configured; the
 * deployment this add-on targets has `dialInConfCodeUrl` and friends commented
 * out, so it has no gateway at all. That is why dial-in is a per-deployment
 * capability rather than unconditional code: a fetch on the conference
 * creation path costs latency against Marketplace's 5-second budget, in
 * exchange for entry points the deployment cannot serve.
 *
 * https://api.jitsi.net is undocumented (jitsi.org/CloudAPI is a 404) but is
 * live, and is what meet.jit.si's own config.js points `dialInNumbersUrl` and
 * `dialInConfCodeUrl` at.
 */

const JITSI_NET_CONFERENCE_MAPPER = 'https://api.jitsi.net/conferenceMapper';
const JITSI_NET_PHONE_NUMBERS = 'https://api.jitsi.net/phoneNumberList';
const JITSI_NET_DIAL_IN_INFO = 'https://meet.jit.si/static/dialInInfo.html';

const JAAS_CONFERENCE_MAPPER =
    'https://8x8.vc/v1/_jaas/vmms-conference-mapper/v1/access';
const JAAS_DIDS =
    'https://8x8.vc/v1/_jaas/vmms-conference-mapper/access/v1/dids';

/**
 * Collects the dial-in details for a room.
 *
 * Never throws: a dial-in service that is slow, down or reconfigured must not
 * take conference creation with it. The worst case is a meeting without phone
 * entry points.
 *
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @return {Object} {numbers: string[], pin: ?string, moreLink: ?string}
 */
function fetchDialIn(deployment, roomName) {
  try {
    switch (deployment.dialIn) {
      case DIAL_IN_JITSI_NET:
        return jitsiNetDialIn_(deployment, roomName);
      case DIAL_IN_JAAS:
        return jaasDialIn_(deployment, roomName);
      default:
        return noDialIn_();
    }
  } catch (err) {
    console.log('Dial-in lookup failed, continuing without phone entry points: ' + err);
    return noDialIn_();
  }
}

function noDialIn_() {
  return {numbers: [], pin: null, moreLink: null};
}

/**
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @return {Object}
 */
function jitsiNetDialIn_(deployment, roomName) {
  // The mapper is create-or-retrieve and deterministic: the same room always
  // returns the same numeric id, so a PIN fetched now stays valid and does not
  // need refetching on later event updates.
  const mapping = fetchJson_(JITSI_NET_CONFERENCE_MAPPER, {
    conference: roomName + '@' + mucHost(deployment),
  });

  const listed = fetchJson_(JITSI_NET_PHONE_NUMBERS, {calendar: 'true'});

  return {
    numbers: flattenCountryNumbers_(listed.numbers),
    pin: mapping.id == null ? null : String(mapping.id),
    moreLink: JITSI_NET_DIAL_IN_INFO + '?room=' + encodeURIComponent(roomName),
  };
}

/**
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @return {Object}
 */
function jaasDialIn_(deployment, roomName) {
  const mapping = fetchJson_(JAAS_CONFERENCE_MAPPER, {
    conference: roomName + '@' + mucHost(deployment),
  });

  const dids = fetchJson_(JAAS_DIDS, {});

  return {
    numbers: (dids || [])
        .map(did => did && did.formattedNumber)
        .filter(Boolean)
        .map(toDialable_),
    pin: mapping.id == null ? null : String(mapping.id),
    // JaaS has no public "more numbers" page equivalent to meet.jit.si's.
    moreLink: null,
  };
}

/**
 * `api.jitsi.net` groups numbers by country code. The add-on wants a flat
 * list; the country is already encoded in the number itself.
 *
 * @param {?Object} numbers country code to array of numbers.
 * @return {string[]}
 */
function flattenCountryNumbers_(numbers) {
  if (!numbers) {
    return [];
  }

  return Object.keys(numbers)
      .reduce((all, country) => all.concat(numbers[country] || []), [])
      .map(toDialable_);
}

/**
 * Normalises a display number into something a `tel:` URI can carry. The
 * service returns `+1.512.647.1431`; the dots are cosmetic.
 *
 * @param {string} number the number as listed.
 * @return {string}
 */
function toDialable_(number) {
  return String(number).replace(/[^\d+]/g, '');
}

/**
 * @param {string} url the endpoint, without a query string.
 * @param {Object} params query parameters.
 * @return {Object} the parsed response.
 */
function fetchJson_(url, params) {
  const query = Object.keys(params)
      .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(params[key]))
      .join('&');

  const response = UrlFetchApp.fetch(query ? url + '?' + query : url, {
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('GET ' + url + ' returned HTTP ' + code);
  }

  return JSON.parse(response.getContentText());
}
