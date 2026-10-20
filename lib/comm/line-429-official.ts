/**
 * QTA-01 / QTA-06: official LINE Messaging API 429 `message` values.
 * Source: https://developers.line.biz/en/reference/messaging-api/
 * (Common specifications → Status codes / Error responses).
 */
export const LINE_429_DOCS_URL = "https://developers.line.biz/en/reference/messaging-api/";
export const LINE_429_STATUS_CODES_URL = "https://developers.line.biz/en/reference/messaging-api/#status-codes";
export const LINE_429_ERROR_RESPONSES_URL = "https://developers.line.biz/en/reference/messaging-api/#error-responses";

/** Status codes table: 429 Too Many Requests covers both rate and monthly quota. */
export const LINE_429_STATUS_QUOTE =
  "Exceeded the rate limit for requests. Exceeded the Limit on the number of concurrent operations for requests. Exceeded the number of free messages. Exceeded your maximum number of additional messages allowed to be sent.";

/** Error responses table — monthly quota. */
export const LINE_429_MONTHLY_LIMIT_MESSAGE = "You have reached your monthly limit.";
export const LINE_429_MONTHLY_LIMIT_QUOTE =
  "Exceeded the number of free messages. Exceeded your maximum number of additional messages allowed to be sent.";

/** Error responses table — request rate. */
export const LINE_429_RATE_LIMIT_MESSAGE = "The API rate limit has been exceeded. Try again later.";
export const LINE_429_RATE_LIMIT_QUOTE = "Exceeded the rate limit for requests.";
