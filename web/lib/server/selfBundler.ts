import "server-only";
/** F-02: the protocol never bundles user operations, even if an old self-bundler env flag is set. */
export async function selfBundle(_method: string, _params: unknown[], _o?: unknown): Promise<never> {
  throw new Error("protocol relay disabled");
}
