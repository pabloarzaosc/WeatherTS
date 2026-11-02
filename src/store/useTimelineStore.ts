import { create } from "zustand";

/** What drives the map timeline. */
export type TimelineDriver = "radar" | "sat" | "obs" | "lsr" | "fronts" | "sounding";

/**
 * Whether the map timeline is playing, and what it plays -- for the parts of
 * the app outside the timeline that follow a play: the loading card shows the
 * radar loop coming in while a radar loop plays. The timeline owns the state
 * and writes it here; `stop` asks it to pause (the card's Stop button).
 */
interface TimelineState {
  playing: boolean;
  driver: TimelineDriver | null;
  /** Bumped by `stop`; the timeline pauses when it changes. */
  stops: number;
  /** Bumped by `resume`; the timeline plays again when it changes (a loop
   *  paused because the window was hidden, backgroundMode.ts). */
  resumes: number;
  /** The play speed the timeline is set to (PLAY_SPEEDS), for the Export page's "Loop speed". */
  speed: number;
  setSpeed: (speed: number) => void;
  setPlaying: (playing: boolean, driver: TimelineDriver | null) => void;
  stop: () => void;
  resume: () => void;
}

export const useTimelineStore = create<TimelineState>()((set, get) => ({
  playing: false,
  driver: null,
  stops: 0,
  resumes: 0,
  speed: 1,
  setSpeed: (speed) => {
    if (speed !== get().speed) set({ speed });
  },
  setPlaying: (playing, driver) => {
    if (playing !== get().playing || driver !== get().driver) set({ playing, driver });
  },
  stop: () => set({ stops: get().stops + 1 }),
  resume: () => set({ resumes: get().resumes + 1 }),
}));
