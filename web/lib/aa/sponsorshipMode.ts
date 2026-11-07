/** Explicit opt-in only. Never silently switch modes after a possibly submitted operation. */
export const selfBundlerMode = () => process.env.GAS_SPONSORSHIP_MODE === "self";
export const clientSelfBundlerMode = () => process.env.NEXT_PUBLIC_GAS_SPONSORSHIP_MODE === "self";
