# disciple.xyz: site concept (not live)

A parked concept for the public site. The hook and the bridge launch together, and only after every audit is finished. This is not wired into the app and should not be deployed yet.

Mockup: [`landing-pregame.html`](landing-pregame.html) is a single self-contained file. Open it in a browser to view it.

## Site map

| URL | What it is | Main action |
| --- | --- | --- |
| disciple.xyz | Landing page for the hook and the bridge (the launchpad gets added after the game launches) | Launch a pool / Launch a bridge |
| disciple.xyz/hook | Launch a Disciple pool | Launch a pool |
| disciple.xyz/hook/pools | Pool browser (needed on day one) | Open a pool |
| disciple.xyz/hook/{chain}/{pool} | One pool: price, size, the LP line, deposit | Deposit |
| disciple.xyz/bridge | Launch a permissionless bridge to a new chain | Launch a bridge |
| disciple.xyz/bridge/{token}/{chain} | One bridge: send tokens, then "launch a pool there" | Send tokens |
| disciple.xyz/docs | Docs for everything (all jargon goes here) | Read |
| app.disciple.xyz | The launchpad game (moves from disciple.vip, no redirect needed) | Play |

## Two states of the root page

- **Before the game:** hook and bridge only. The launchpad is not mentioned anywhere.
- **After the game:** the hero leads with the launchpad (Play → app.disciple.xyz), and the hook and bridge become "tools for teams" further down. One config flag switches between the two states.

## Look (decided 4 Nov 2026)

- Use the **Afterimage** concept as-is: film grain, ice-blue fog, a light trail in the hero, glowing type with soft chromatic edges, mono micro-text columns, and a justified mono manifesto. Don't blend it with the app's brand-guidelines look (that was tried and rejected).
- The hero reads **DISCIPLE / FOLLOW THE LEADER**. DISCIPLE is the outlined brand wordmark (`web/public/brand/disciple-wordmark-light.svg`), never the dot-matrix pixel font. It has no blinking or flicker.
- The **11a Spire Star** (from the brand guidelines, `11a-spire-star.svg` here) is the light at the trail head and in the Afterglow section.
- **How it works = the orbit.** The center planet is labeled MAIN TOKEN POOL ("the leader that draws all pools back to it"). The bodies orbiting it are each labeled DISCIPLE POOL, and the front one leaves fading afterimages.

## Still to do

- **Copy needs a rewrite.** The current text is placeholder.
- Real links, the X handle, and audit report links.
- The after-game version of the root page, plus the /hook, /bridge and pool pages.
