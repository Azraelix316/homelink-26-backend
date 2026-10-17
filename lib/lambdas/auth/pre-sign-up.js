/**
 * Cognito pre sign-up trigger.
 *
 * Self sign-up has to be enabled on the user pool so the backend can call
 * SignUp (which sends Cognito's verification email), but that also lets anyone
 * call SignUp directly with the public app client. Only the backend's
 * registration client may write custom:userId and custom:role, so a sign-up
 * without them did not come through POST /auth/register and is rejected.
 */
exports.handler = async (event) => {
  const attributes = event.request.userAttributes || {};

  if (!attributes['custom:userId'] || !['tradie', 'homeowner'].includes(attributes['custom:role'])) {
    throw new Error('Registration must go through the HomeLink API');
  }

  // Never auto-confirm: the user must prove they own the email address
  event.response.autoConfirmUser = false;
  event.response.autoVerifyEmail = false;
  return event;
};
