/**
 * Spectator timeline reducer tests (#1692).
 *
 * The reducer must never leave the cursor outside the loaded events, and a
 * live timeline must keep tracking the newest event.
 */
import {
  createSpectatorTimelineState,
  spectatorTimelineReducer,
  type SpectatorTimelineState,
} from "../replay/spectatorTimeline";

function loaded(length: number, state?: SpectatorTimelineState): SpectatorTimelineState {
  return spectatorTimelineReducer(state ?? createSpectatorTimelineState(), { type: "loaded", length });
}

describe("spectatorTimelineReducer (#1692)", () => {
  it("starts live and follows the newest event as segments load", () => {
    const state = loaded(5);
    expect(state).toMatchObject({ mode: "live", cursor: 4, length: 5, playing: false });
    expect(loaded(8, state)).toMatchObject({ mode: "live", cursor: 7, length: 8 });
  });

  it("seek and step leave live mode and clamp to the loaded range", () => {
    const live = loaded(5);
    expect(spectatorTimelineReducer(live, { type: "seek", index: 2 })).toMatchObject({ mode: "replay", cursor: 2 });
    expect(spectatorTimelineReducer(live, { type: "seek", index: 99 })).toMatchObject({ cursor: 4 });
    expect(spectatorTimelineReducer(live, { type: "seek", index: -3 })).toMatchObject({ cursor: 0 });
    expect(spectatorTimelineReducer(live, { type: "seek", index: Number.NaN })).toMatchObject({ cursor: 0 });
    const atStart = spectatorTimelineReducer(live, { type: "seek", index: 0 });
    expect(spectatorTimelineReducer(atStart, { type: "step", delta: -1 })).toMatchObject({ cursor: 0 });
    expect(spectatorTimelineReducer(atStart, { type: "step", delta: 2 })).toMatchObject({ cursor: 2 });
  });

  it("play advances on tick and stops at the end", () => {
    let state = spectatorTimelineReducer(loaded(3), { type: "seek", index: 0 });
    state = spectatorTimelineReducer(state, { type: "play" });
    expect(state).toMatchObject({ playing: true, cursor: 0 });
    state = spectatorTimelineReducer(state, { type: "tick" });
    expect(state.cursor).toBe(1);
    state = spectatorTimelineReducer(state, { type: "tick" });
    expect(state).toMatchObject({ cursor: 2, playing: false });
    expect(spectatorTimelineReducer(state, { type: "tick" })).toMatchObject({ cursor: 2, playing: false });
  });

  it("play from the end restarts from the beginning", () => {
    const atEnd = loaded(3);
    expect(spectatorTimelineReducer(atEnd, { type: "play" })).toMatchObject({ mode: "replay", playing: true, cursor: 0 });
  });

  it("play does nothing before any events are loaded", () => {
    const empty = loaded(0);
    expect(spectatorTimelineReducer(empty, { type: "play" })).toEqual(empty);
    expect(spectatorTimelineReducer(empty, { type: "seek", index: 4 })).toMatchObject({ cursor: 0 });
  });

  it("tick is ignored while paused", () => {
    const paused = spectatorTimelineReducer(loaded(3), { type: "seek", index: 1 });
    expect(spectatorTimelineReducer(paused, { type: "tick" })).toEqual(paused);
  });

  it("goLive returns to the newest event and stops playback", () => {
    let state = spectatorTimelineReducer(loaded(4), { type: "play" });
    state = spectatorTimelineReducer(state, { type: "goLive" });
    expect(state).toMatchObject({ mode: "live", playing: false, cursor: 3 });
  });

  it("changes speed without moving the cursor", () => {
    const state = spectatorTimelineReducer(loaded(4), { type: "setSpeed", speed: 4 });
    expect(state).toMatchObject({ speed: 4, cursor: 3, mode: "live" });
  });

  it("unavailable blocks navigation until a verified reload", () => {
    const broken = spectatorTimelineReducer(loaded(4), { type: "unavailable", reason: "checksum_mismatch" });
    expect(broken).toMatchObject({ status: "unavailable", unavailableReason: "checksum_mismatch", playing: false });
    expect(spectatorTimelineReducer(broken, { type: "seek", index: 0 })).toBe(broken);
    expect(spectatorTimelineReducer(broken, { type: "play" })).toBe(broken);

    const recovered = loaded(6, broken);
    expect(recovered).toMatchObject({ status: "ready", unavailableReason: null, cursor: 5, length: 6 });
  });
});
