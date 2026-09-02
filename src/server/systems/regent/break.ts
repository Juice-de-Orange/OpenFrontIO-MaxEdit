/**
 * An operator's way to prove the phase-10 gate can fail.
 *
 * `blind` is a steward that cannot see the sky: `assess` reports no hostile
 * air, so the base, the fighter line and the wing never come, and the
 * gate's air checks fall while everything before them stands. Only a test
 * world may set it (`Main.ts` refuses it without `WORLD_TICK_MS`), and a
 * world that runs blind says so on every start.
 *
 * Module state rather than a field on the world on purpose: the simulation
 * reads no environment (§9), so the flag is set once at start-up and the
 * rules only ever read it.
 */

export type RegentBreak = "blind" | null;

let current: RegentBreak = null;

export function setRegentBreak(mode: RegentBreak): void {
  current = mode;
}

export function regentBreak(): RegentBreak {
  return current;
}
