import "server-only";
// Compatibility export for tests/tools. External bundler manages prefund reservation; no protocol keeper or relay.
export { configuredPrepaidPaymaster as allowedPaymaster } from "./prepaidPaymaster";
