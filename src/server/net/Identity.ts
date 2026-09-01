/**
 * Who a session is, and which nation that lets it be.
 *
 * Phase 11 (decision 0013): since phase 7 a session could claim any nation
 * in its `hello`, read that nation's treaty terms and cancel its agreements
 * — and a guarantee the code cannot enforce is not a guarantee. This module
 * is the enforcement, kept apart from the socket so the rules are testable
 * without one, and apart from the world so the simulation stays account-free
 * (decision 0019).
 *
 * Registration is deliberately minimal: a name in, an opaque token out,
 * exactly once. The token is the credential — there is no password and no
 * recovery, because this is a hobby world and a lost token is a new account.
 * Only the token's SHA-256 is stored, so a database dump leaks nothing a
 * session could log in with.
 */

import { createHash, randomBytes } from "node:crypto";
import type { WorldStore } from "../db/Store";

export interface Account {
  id: string;
  name: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

export class IdentityService {
  constructor(
    private readonly store: WorldStore,
    private readonly worldId: string,
  ) {}

  /** Create an account and hand back the one copy of its token. */
  async register(name: string): Promise<{ account: Account; token: string }> {
    const id = randomBytes(8).toString("hex");
    const token = randomBytes(32).toString("hex");
    await this.store.createAccount(id, name, hashToken(token));
    return { account: { id, name }, token };
  }

  /** The account a token belongs to, or null for a credential nobody has. */
  async authenticate(token: string): Promise<Account | null> {
    return this.store.accountByTokenHash(hashToken(token));
  }

  /**
   * Let an account take a nation, under the season's two rules: one account
   * per nation, one nation per account, for the life of the season. A free
   * nation is claimed on the spot — §10's "new players take a nation no
   * account holds", inheriting whatever the regent built.
   */
  async claim(
    nationId: number,
    accountId: string,
  ): Promise<"ok" | "taken" | "elsewhere"> {
    return this.store.claimNation(this.worldId, nationId, accountId);
  }
}
