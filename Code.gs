/**
 * Entry point for the Jitsi Meet conference solution.
 *
 * Called by Calendar when a user adds this add-on's conference type to an
 * event. Configuration lives in Config.gs, token minting in Jwt.gs and dial-in
 * lookups in JitsiDialIn.gs.
 */

/**
 * Creates a conference, then builds and returns a ConferenceData object with
 * the corresponding conference information. Referenced as `onCreateFunction`
 * by the conference solution in appsscript.json.
 *
 * @param {Object} arg the argument passed to an onCreateFunction; carries
 *     information about the Google Calendar event.
 * @return {ConferenceData}
 */
function createConference(arg) {
  const eventData = arg.eventData;

  // Retrieve the Calendar event information using the Calendar advanced
  // service.
  let calendarEvent;
  try {
    calendarEvent = Calendar.Events.get(eventData.calendarId, eventData.eventId);
  } catch (err) {
    // The calendar event does not exist just yet; proceed with the given event
    // ID and allow the event details to sync later.
    console.log(err);
    calendarEvent = {id: eventData.eventId};
  }

  const dataBuilder = ConferenceDataService.newConferenceDataBuilder();
  const conference = create3rdPartyConference(calendarEvent);

  if (conference.error) {
    return dataBuilder.setError(ConferenceDataService.newConferenceError()
        .setConferenceErrorType(ConferenceDataService.ConferenceErrorType.TEMPORARY))
        .build();
  }

  dataBuilder
      .setConferenceId(conference.id)
      // Documented as required for Workspace add-ons and ignored for
      // conferencing add-ons, which is what this is. Set for correctness;
      // it is not what drives the conference icon.
      .setConferenceSolutionId(CONFERENCE_SOLUTION_ID)
      .addConferenceParameter(ConferenceDataService.newConferenceParameter()
          .setKey('conferenceSolutionType')
          .setValue('jitsi'));

  conference.entryPoints.forEach(entryPoint => dataBuilder.addEntryPoint(entryPoint));

  return dataBuilder.build();
}

/**
 * Creates the conference on the Jitsi deployment and collects everything
 * needed to describe it to Calendar.
 *
 * @param {Object} calendarEvent a Calendar Event resource.
 * @return {Object} {id, videoUri, entryPoints, roomName, error}
 */
function create3rdPartyConference(calendarEvent) {
  const deployment = getDeployment();
  const roomName = Utilities.getUuid();

  const token = createConferenceToken(
      deployment, roomName, participantFor_(calendarEvent));

  const videoUri = buildVideoUri_(
      deployment, roomName, token, calendarEvent.summary);

  const dialIn = fetchDialIn(deployment, roomName);

  return {
    id: deployment.domain + '/' + roomName,
    videoUri: videoUri,
    roomName: roomName,
    entryPoints: buildEntryPoints_(videoUri, dialIn),
    error: false,
  };
}

/**
 * Builds the entry point list.
 *
 * @param {string} videoUri the join URL.
 * @param {Object} dialIn as returned by fetchDialIn().
 * @return {EntryPoint[]}
 */
function buildEntryPoints_(videoUri, dialIn) {
  const entryPoints = [
    ConferenceDataService.newEntryPoint()
        .setEntryPointType(ConferenceDataService.EntryPointType.VIDEO)
        .setUri(videoUri),
  ];

  dialIn.numbers.forEach(number => {
    const phoneEntryPoint = ConferenceDataService.newEntryPoint()
        .setEntryPointType(ConferenceDataService.EntryPointType.PHONE)
        .setUri('tel:' + number);
    if (dialIn.pin) {
      phoneEntryPoint.setPin(dialIn.pin);
    }
    entryPoints.push(phoneEntryPoint);
  });

  // A MORE entry point may not be the only entry point, and it only means
  // anything when the deployment actually has a dial-in gateway.
  if (dialIn.moreLink) {
    entryPoints.push(ConferenceDataService.newEntryPoint()
        .setEntryPointType(ConferenceDataService.EntryPointType.MORE)
        .setUri(dialIn.moreLink));
  }

  return entryPoints;
}

/**
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @param {?string} token the JWT, if the deployment uses one.
 * @param {?string} subject the meeting title, shown in the Jitsi UI.
 * @return {string}
 */
function buildVideoUri_(deployment, roomName, token, subject) {
  let uri = 'https://' + deployment.domain + '/' + roomPath(deployment, roomName);

  if (token) {
    uri += '?jwt=' + encodeURIComponent(token);
  }

  if (subject) {
    // `config.subject` is what the Jitsi UI renders as the meeting name.
    // `config.callDisplayName`, which this add-on used previously, is the iOS
    // CallKit name and does nothing here. The value sits in the URL fragment
    // and must be percent-encoded: encodeURI leaves `&`, `=` and `#` alone,
    // which would let a title inject further config parameters.
    uri += '#config.subject=' + encodeURIComponent(subject);
  }

  return uri;
}

/**
 * Describes the participant the shared token is minted for.
 *
 * The token ends up in an invitation URL that every attendee receives, so
 * there is exactly one of them, not one per participant. That is why the
 * default is an empty identity: putting the organiser's name and address in a
 * token that everyone shares would not identify the organiser, it would present
 * every guest as the organiser. An empty identity leaves Jitsi to name each
 * person individually, which is what the add-on did before.
 *
 * A genuinely per-participant identity is not reachable from here. It needs a
 * token minted when the link is clicked, which needs a redirector service
 * sitting between the invitation and the room.
 *
 * @param {Object} calendarEvent a Calendar Event resource.
 * @return {Object} {id, name, email, moderator}
 */
function participantFor_(calendarEvent) {
  if (getTokenIdentity() === 'none') {
    return {id: '', name: '', email: '', moderator: grantsModerator()};
  }

  const organizer = calendarEvent.organizer || {};
  const self = (calendarEvent.attendees || []).filter(a => a.self)[0] || {};
  const email = self.email || organizer.email || '';

  return {
    id: email,
    name: organizer.displayName || '',
    email: email,
    moderator: grantsModerator(),
  };
}
