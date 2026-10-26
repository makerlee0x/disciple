/** Player-facing invite copy (plain words). Copy pending lee / BRAND approval. */
export const INVITE_COPY = {
  "gate.title": "DISCIPLE is invite-only for now.",
  "gate.body": "Have a code? Enter it here.",
  "gate.banner.link": "Enter a code",
  "redeem.label": "Invite code",
  "redeem.placeholder": "ABCD2345",
  "redeem.button": "Use code",
  "waitlist.button": "Join the waitlist",
  "waitlist.done": "You're on the list. We'll let you in soon.",
  "signin.title": "Sign in to use your invite",
  "signin.body": "Sign in with email or Google. Then enter your code.",
  "signin.button": "Sign in",
  "in.title": "You're in.",
  "invites.count": (n: number) => (n === 1 ? "You have 1 invite." : `You have ${n} invites.`),
  "invites.none": "You've shared all your invites.",
  "invites.help": "Each code works once. Send one to a friend.",
  "invites.copy": "Copy link",
  "invites.copied": "Copied",
  "invites.used": "used",
  "invites.unused": "unused",
  "off.title": "No invite needed right now.",
  "off.body": "Anyone can play. Come on in.",
  "off.home": "Go to the launchpad",
  "error.bad_code": "That code doesn't work. Check it, or ask a friend for a new one.",
  "error.used": "That code was already used. Ask a friend for a new one.",
  "error.own_code": "You can't use your own code. Send it to a friend.",
  "error.already_in": "You're already in.",
  "error.busy": "One moment. Try again.",
  "error.generic": "Something went wrong. Try again.",
} as const;
export type InviteErr = "bad_code" | "used" | "own_code" | "already_in" | "busy";
export const inviteErrorText = (e: string | undefined) =>
  (e && (`error.${e}` as const) in INVITE_COPY ? INVITE_COPY[`error.${e}` as `error.${InviteErr}`] : INVITE_COPY["error.generic"]);
