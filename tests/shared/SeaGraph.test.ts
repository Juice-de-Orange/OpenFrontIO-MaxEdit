import { describe, expect, test } from "vitest";
import {
  seaDistance,
  seaPath,
  seaZoneAdjacency,
} from "../../src/shared/map/SeaGraph";
import { islandFixture, mapFixture } from "../util/worldFixture";

describe("the sea's graph", () => {
  test("zones touching over open water are neighbours, symmetrically", () => {
    const { map } = islandFixture();
    expect(map.seaZoneCount).toBeGreaterThanOrEqual(2);
    const zones = seaZoneAdjacency(map);
    expect(zones.length).toBe(map.seaZoneCount);
    for (let zone = 0; zone < zones.length; zone++) {
      // No zone is its own neighbour, and every edge runs both ways.
      expect(zones[zone].has(zone)).toBe(false);
      for (const other of zones[zone]) {
        expect(zones[other].has(zone)).toBe(true);
      }
    }
    // The strait cuts into a chain, so somebody has a neighbour at all.
    expect(zones.some((set) => set.size > 0)).toBe(true);
  });

  test("a path crosses the chain, and a zone reaches itself for free", () => {
    const { map } = islandFixture();
    const last = map.seaZoneCount - 1;
    const path = seaPath(map, 0, last);
    expect(path).not.toBeNull();
    const crossing = path as number[];
    expect(crossing[0]).toBe(0);
    expect(crossing[crossing.length - 1]).toBe(last);
    expect(seaDistance(map, 0, last)).toBe(crossing.length - 1);
    expect(seaPath(map, 0, 0)).toEqual([0]);
    expect(seaDistance(map, 0, 0)).toBe(0);
  });

  test("out-of-range zones are null, not a crash and not zone zero", () => {
    const { map } = islandFixture();
    expect(seaPath(map, -1, 0)).toBeNull();
    expect(seaPath(map, 0, map.seaZoneCount)).toBeNull();
  });

  test("a lake is not a theatre: water without the ocean bit has no graph", () => {
    // The standard fixture's margin is bare water — no ocean bit — so it gets
    // no sea zones and the graph is empty rather than wrong.
    const { map } = mapFixture({
      width: 320,
      height: 140,
      capitals: [
        { x: 40, y: 40 },
        { x: 280, y: 100 },
      ],
    });
    expect(map.seaZoneCount).toBe(0);
    expect(seaZoneAdjacency(map)).toHaveLength(0);
    expect(seaPath(map, 0, 0)).toBeNull();
  });
});
