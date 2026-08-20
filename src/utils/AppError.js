// Lightweight error type carrying an HTTP status code, so controllers can translate
// service failures into consistent API responses without guessing status codes.
class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = AppError;
