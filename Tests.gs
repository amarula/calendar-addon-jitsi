/**
 * Manual checks to run from the Apps Script editor before testing in Calendar.
 *
 * Deliberately not a unit-test framework. The failures that matter in this
 * add-on are misconfiguration (wrong or missing Script Properties) and claim
 * shape (what the Jitsi server will actually accept), and both are visible by
 * inspection. Select `runSelfTest` in the editor and press Run, then read the
 * execution log.
 *
 * Nothing here logs the shared secret or the private key: `getDeployment()`
 * returns them, so this file only ever prints selected fields.
 */

/**
 * Prints the resolved deployment, mints a token, decodes its claims and builds
 * the join URI. Throws early and loudly if configuration is incomplete.
 */
function runSelfTest() {
  const deployment = getDeployment();

  log_('--- deployment ---');
  log_('mode       : ' + deployment.mode);
  log_('domain     : ' + deployment.domain);
  log_('muc        : ' + mucHost(deployment));
  log_('jwt alg    : ' + (deployment.jwtAlgorithm || 'none (no token minted)'));
  log_('dial-in    : ' + (deployment.dialIn || 'none (no phone entry points)'));
  log_('token TTL  : ' + getTokenTtlHours() + ' hours');
  log_('moderator  : ' + grantsModerator());
  if (deployment.checkinUrl) {
    log_('check-in   : ' + deployment.checkinUrl);
    log_('ticket TTL : ' + getTicketTtlHours() + ' hours');
  }

  const roomName = 'selftest-' + Utilities.getUuid().slice(0, 8);
  const participant = {
    id: 'selftest@example.com',
    name: 'Self Test',
    email: 'selftest@example.com',
    moderator: grantsModerator(),
  };

  log_('--- token ---');
  const token = createConferenceToken(deployment, roomName, participant);
  if (token) {
    const claims = JSON.parse(Utilities.newBlob(
        Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString());
    log_(JSON.stringify(claims, null, 2));

    if (claims.room !== roomName) {
      log_('PROBLEM: claim room does not match the room being joined');
    }
    if (deployment.mode === 'JAAS' &&
        (claims.aud !== 'jitsi' || claims.iss !== 'chat')) {
      log_('PROBLEM: JaaS requires aud="jitsi" and iss="chat"');
    }
  } else {
    log_('(none: this deployment authenticates by other means)');
  }

  log_('--- join URI ---');
  const videoUri = buildVideoUri_(deployment, roomName, token, 'Self test & title');
  log_(videoUri);
  if (videoUri.indexOf('callDisplayName') >= 0) {
    log_('PROBLEM: callDisplayName is the iOS CallKit name and does nothing here');
  }

  log_('--- dial-in ---');
  log_(JSON.stringify(fetchDialIn(deployment, roomName)));

  if (deployment.mode === 'CHECKIN') {
    log_('--- room ticket ---');
    const ticket = createRoomTicket(
        deployment, roomName, 'selftest@example.com', 'Self test & title');
    const claims = JSON.parse(Utilities.newBlob(
        Utilities.base64DecodeWebSafe(ticket.split('.')[1])).getDataAsString());
    log_(JSON.stringify(claims, null, 2));

    // The point of a ticket is that it names nobody. If this ever reads true,
    // something identifying has leaked into every invitation.
    const identifying = ['id', 'name', 'email', 'context']
        .filter(key => key in claims);
    log_('ticket names somebody: ' +
        (identifying.length ? 'YES -- ' + identifying.join(', ') : 'no'));
    log_('clickable: ' + deployment.checkinUrl + '?g=' +
        encodeURIComponent(ticket));
  }

  log_('--- self test finished ---');
}

/**
 * Exercises the conference assembly with a synthetic event, which is the
 * closest thing to the real `onCreateFunction` path that can be run by hand.
 *
 * The entry points it produces are `ConferenceDataService` objects, which are
 * only meaningful inside a Calendar invocation; if that throws, it does not
 * necessarily mean the add-on is broken. Everything logged before the throw is
 * still valid.
 */
function runConferenceDryRun() {
  const conference = create3rdPartyConference({
    summary: 'Dry run & test',
    organizer: {email: 'selftest@example.com', displayName: 'Self Test'},
    attendees: [{email: 'selftest@example.com', self: true}],
  });

  log_('conference id  : ' + conference.id);
  log_('room name      : ' + conference.roomName);
  log_('entry point cnt: ' + conference.entryPoints.length);
  log_('video uri      : ' + conference.videoUri);

  const roomName = conference.roomName;
  log_('room name is bare (no @conference): ' + (roomName.indexOf('@') < 0));
  log_('video uri targets the configured domain: ' +
      (conference.videoUri.indexOf('https://' + getDeployment().domain + '/') === 0));
}

/**
 * Lists the script properties this project actually holds.
 *
 * "I set it and nothing changed" is almost always one of three things: the
 * save did not land, the value went to a different project, or the name has a
 * typo or stray space. All three are visible in a list of names, and none are
 * visible from the outside -- script properties cannot be read through clasp
 * or the Apps Script API, only from inside the project.
 *
 * Values are printed for ordinary settings. Secrets are reported by length, so
 * this can be run and its output pasted around without leaking a key.
 */
function listScriptProperties() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const names = Object.keys(all).sort();

  if (!names.length) {
    log_('No script properties are set on this project.');
    log_('If you just set some, check you are in the right project and that ' +
        'you pressed "Save script properties".');
    return;
  }

  const secret = ['APP_SECRET', 'TICKET_SECRET', 'JAAS_PRIVATE_KEY'];
  log_(names.length + ' propert' + (names.length === 1 ? 'y' : 'ies') +
      ' on this project:');

  names.forEach(name => {
    const raw = String(all[name]);
    log_('  ' + name + ' = ' + (secret.indexOf(name) >= 0
        ? '[' + raw.length + ' characters, hidden]'
        : raw) +
        (raw.trim() !== raw ? '   <-- has leading or trailing whitespace' : ''));
  });

  // The value the check-in page checks signatures with has to match this one
  // exactly; the length is the only comparison available from here.
  if (all.TICKET_SECRET) {
    log_('');
    log_('TICKET_SECRET is ' + String(all.TICKET_SECRET).length +
        ' characters. It must be identical in the check-in project.');
  }

  if (names.indexOf('DEPLOYMENT_MODE') < 0) {
    log_('');
    log_('DEPLOYMENT_MODE is not set, which is why getDeployment() falls back ' +
        'to SELF_HOSTED.');
  } else if (all.DEPLOYMENT_MODE !== 'CHECKIN') {
    log_('');
    log_('DEPLOYMENT_MODE is "' + all.DEPLOYMENT_MODE + '", so this project ' +
        'is not using the check-in page. The value is case-sensitive.');
  }
}

/**
 * console.log with a single string argument, so nothing depends on the
 * runtime's format-specifier support.
 *
 * @param {string} message the line to log.
 */
function log_(message) {
  console.log(message);
}
