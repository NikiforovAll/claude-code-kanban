// An error a route answers with `status`; `code` is the machine-readable reason, where one is set.
// `expose` lets the API error handler send the message for a 5xx too, because it was written for the user.
function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

module.exports = { httpError };
