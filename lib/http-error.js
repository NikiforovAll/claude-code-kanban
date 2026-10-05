// An error a route answers with `status`; `code` is the machine-readable reason, where one is set.
function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

module.exports = { httpError };
