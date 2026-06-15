const MAX_URL_LENGTH = 2048;
const MAX_DEPTH = 5;
const MAX_WAIT = 30000;

function validationError(message, field) {
  const error = new Error(message);
  error.code = "VALIDATION_ERROR";
  error.statusCode = 400;
  error.field = field;
  return error;
}

function booleanOption(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw validationError(`${field} must be a boolean`, field);
  }
  return value;
}

function integerOption(value, fallback, minimum, maximum, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw validationError(
      `${field} must be an integer between ${minimum} and ${maximum}`,
      field,
    );
  }
  return value;
}

export function validateJobInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("Request body must be a JSON object");
  }
  if (typeof input.url !== "string" || input.url.length === 0) {
    throw validationError("url is required", "url");
  }
  if (input.url.length > MAX_URL_LENGTH) {
    throw validationError(`url must be at most ${MAX_URL_LENGTH} characters`, "url");
  }

  let parsed;
  try {
    parsed = new URL(input.url.trim());
  } catch {
    throw validationError("url must be a valid absolute URL", "url");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw validationError("url must use http or https", "url");
  }
  if (parsed.username || parsed.password) {
    throw validationError("url credentials are not allowed", "url");
  }
  if (!parsed.hostname) {
    throw validationError("url must include a hostname", "url");
  }

  const options = input.options ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw validationError("options must be an object", "options");
  }

  return {
    url: parsed.href,
    options: {
      dark: booleanOption(options.dark, true, "options.dark"),
      screenshots: booleanOption(
        options.screenshots,
        true,
        "options.screenshots",
      ),
      depth: integerOption(options.depth, 1, 0, MAX_DEPTH, "options.depth"),
      wait: integerOption(options.wait, 1500, 0, MAX_WAIT, "options.wait"),
      layout: booleanOption(options.layout, true, "options.layout"),
    },
  };
}

export function validateJobId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{7,63}$/i.test(value)) {
    const error = validationError("Invalid job id");
    error.statusCode = 404;
    throw error;
  }
  return value;
}
