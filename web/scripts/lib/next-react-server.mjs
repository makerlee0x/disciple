// Test harness only (node --import): under `--conditions=react-server`, Next 15 server modules (next/server, route
// handlers) resolve `react` to the app's React 18 `react.shared-subset` entry, which throws "not yet supported outside of
// experimental channels". The real Next 15 runtime aliases `react` to its vendored build (next/dist/compiled/react);
// mirror that alias here so route-level tests load the same React the deployed server uses. No app code changes.
import { registerHooks } from "node:module";
const MAP = { "react": "next/dist/compiled/react", "react/jsx-runtime": "next/dist/compiled/react/jsx-runtime", "react/jsx-dev-runtime": "next/dist/compiled/react/jsx-dev-runtime", "react-dom": "next/dist/compiled/react-dom" };
registerHooks({ resolve(spec, ctx, next) { const m = MAP[spec]; return next(m ?? spec, ctx); } });
