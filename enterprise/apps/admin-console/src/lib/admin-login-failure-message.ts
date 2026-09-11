/**
 * Authentication failures intentionally have one public message. Account
 * state, failed-attempt counters, and lock state stay server-side so the
 * login endpoint cannot be used to enumerate administrators.
 */
export const ADMIN_LOGIN_FAILURE_MESSAGE = "invalid credentials";

/**
 * The login page must not render a message supplied by the API. The caller
 * passes the localized generic copy from its current locale.
 */
export function getLoginFailureStatusMessage(
  _responseMessage: unknown,
  genericMessage: string,
): string {
  return genericMessage;
}
