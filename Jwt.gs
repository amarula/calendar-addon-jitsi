/**
 * JWT creation for the supported Jitsi deployments.
 *
 * The two token-authenticated profiles are not variations on a theme, they are
 * different specs:
 *
 *   SELF_HOSTED  HS256 over `app_secret`, with `iss`/`aud` set to the app id.
 *                https://github.com/jitsi/lib-jitsi-meet/blob/master/doc/tokens.md
 *   JAAS         RS256 over an RSA private key, with `iss` and `aud` FIXED to
 *                "chat" and "jitsi" and the tenant carried in `sub`.
 *                https://developer.8x8.com/jaas/docs/api-keys-jwt/
 *
 * In both, `room` is the bare room name -- never `room@conference.host`.
 */

/**
 * Builds the JWT for the given deployment.
 *
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @param {Object} user the participant the token is minted for.
 * @return {?string} the token, or null when the deployment authenticates by
 *     other means.
 */
function createConferenceToken(deployment, roomName, user) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + Math.round(getTokenTtlHours() * 3600);

  switch (deployment.jwtAlgorithm) {
    case 'HS256':
      return signToken_(
          {alg: 'HS256', typ: 'JWT'},
          selfHostedClaims_(deployment, roomName, user, expiresAt),
          signingInput => base64UrlEncodeBytes_(Utilities.computeHmacSha256Signature(
              signingInput, deployment.sharedSecret, Utilities.Charset.UTF_8)));

    case 'RS256':
      return signToken_(
          {alg: 'RS256', kid: deployment.keyId, typ: 'JWT'},
          jaasClaims_(deployment, roomName, user, issuedAt, expiresAt),
          signingInput => base64UrlEncodeBytes_(Utilities.computeRsaSha256Signature(
              signingInput, deployment.privateKey)));

    case null:
    case undefined:
      return null;

    default:
      throw new Error('Unsupported JWT algorithm "' + deployment.jwtAlgorithm + '".');
  }
}

/**
 * Claims for a self-hosted deployment running token authentication.
 *
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @param {Object} user the participant.
 * @param {number} expiresAt seconds since the epoch.
 * @return {Object}
 */
function selfHostedClaims_(deployment, roomName, user, expiresAt) {
  return {
    iss: deployment.appId,
    aud: deployment.appId,
    // `sub` is the tenant or domain, lowercased.
    sub: deployment.domain.toLowerCase(),
    room: roomName,
    exp: expiresAt,
    context: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: '',
        // Only consulted by the client when the deployment sets
        // `enableUserRolesBasedOnToken`.
        moderator: user.moderator,
      },
    },
  };
}

/**
 * Claims for Jitsi as a Service.
 *
 * @param {Object} deployment as returned by getDeployment().
 * @param {string} roomName the bare room name.
 * @param {Object} user the participant.
 * @param {number} issuedAt seconds since the epoch.
 * @param {number} expiresAt seconds since the epoch.
 * @return {Object}
 */
function jaasClaims_(deployment, roomName, user, issuedAt, expiresAt) {
  return {
    // Fixed for JaaS. Putting the app id here, as the older code did, is
    // rejected by the service.
    aud: 'jitsi',
    iss: 'chat',
    sub: deployment.tenant,
    room: roomName,
    nbf: issuedAt,
    exp: expiresAt,
    context: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: '',
        // The JaaS examples spell the flag as a string; the client only tests
        // truthiness, but match the documented shape.
        moderator: user.moderator ? 'true' : 'false',
      },
      room: {regex: false},
    },
  };
}

/**
 * Assembles and signs a token.
 *
 * @param {Object} header the JOSE header.
 * @param {Object} payload the claim set.
 * @param {function(string): string} sign produces the encoded signature.
 * @return {string}
 */
function signToken_(header, payload, sign) {
  const signingInput = base64UrlEncodeObject_(header) + '.' +
      base64UrlEncodeObject_(payload);
  return signingInput + '.' + sign(signingInput);
}

/**
 * base64url-encodes a JSON object, without padding.
 *
 * @param {Object} value the value to encode.
 * @return {string}
 */
function base64UrlEncodeObject_(value) {
  return Utilities.base64EncodeWebSafe(JSON.stringify(value), Utilities.Charset.UTF_8)
      .replace(/=+$/, '');
}

/**
 * base64url-encodes the byte array that the signing utilities return.
 *
 * This has to stay separate from the object path above: `computeHmacSha256Signature`
 * and `computeRsaSha256Signature` both return a Byte[], and running one through
 * JSON.stringify would encode the digits of the array rather than the bytes.
 *
 * @param {number[]} bytes the signature bytes.
 * @return {string}
 */
function base64UrlEncodeBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
