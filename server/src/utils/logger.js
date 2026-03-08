function format(scope, message, payload) {
  const base = `[${new Date().toISOString()}] [${scope}] ${message}`;
  if (payload === undefined) {
    return base;
  }

  return `${base} ${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
}

function createLogger(scope) {
  return {
    info(message, payload) {
      console.log(format(scope, message, payload));
    },
    warn(message, payload) {
      console.warn(format(scope, message, payload));
    },
    error(message, payload) {
      console.error(format(scope, message, payload));
    }
  };
}

module.exports = { createLogger };
