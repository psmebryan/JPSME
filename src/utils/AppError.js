// Lightweight error type carrying an HTTP status code, so controllers can translate
// service failures into consistent API responses without guessing status codes.
class AppError extends Error {
  // `code` is an optional machine-readable tag for the few failures a client
  // needs to ACT on rather than merely display. Matching on the message text
  // works right up until someone rewords it, and then the behaviour silently
  // disappears with no test failing — a prompt is not an API.
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

module.exports = AppError;
