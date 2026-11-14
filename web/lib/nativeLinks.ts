/**
 * apple-app-site-association for universal links (app/.well-known/apple-app-site-association). Pure (scripts/test-native.mts).
 * Every page opens in the app except the API, the cron and the web push worker.
 */
export function aasa(env: Record<string, string | undefined>) {
  const team = env.APPLE_TEAM_ID?.trim();
  const bundle = env.APNS_BUNDLE_ID?.trim() || "vip.disciple.app";
  const appIDs = team && /^[A-Z0-9]{10}$/.test(team) ? [`${team}.${bundle}`] : [];
  return {
    applinks: {
      details: appIDs.length
        ? [{ appIDs, components: [{ "/": "/api/*", exclude: true }, { "/": "/push-sw*", exclude: true }, { "/": "/_next/*", exclude: true }, { "/": "/*" }] }]
        : [],
    },
    webcredentials: { apps: appIDs },
  };
}
