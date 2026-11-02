import { ListVideo } from "lucide-react";

import { useFramesStore } from "../store/useFramesStore";

/** The timeline's button for the Frames panel (radar loops). */
export function FramesToggle() {
  const open = useFramesStore((s) => s.open);
  const toggle = useFramesStore((s) => s.toggle);
  return (
    <button
      type="button"
      className={`maptimeline__icbtn${open ? " is-active" : ""}`}
      onClick={toggle}
      title={open ? "Close the frames list" : "Frames: every scan in the loop"}
      aria-pressed={open}
    >
      <ListVideo size={15} />
    </button>
  );
}
