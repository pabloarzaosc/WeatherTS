import { useEffect, useRef, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { renderGoogleButton } from "../../lib/googleSignIn";

/** Google's own sign-in button (see lib/googleSignIn.ts), sized to its box and
 *  drawn in the app's light or dark. */
export function GoogleButton({
  client,
  onSession,
  onError,
  onStart,
}: {
  client: SupabaseClient;
  onSession?: (s: Session) => void;
  onError: (message: string) => void;
  onStart?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const dark = document.documentElement.dataset.theme !== "light";
    renderGoogleButton(el, client, {
      dark,
      width: el.clientWidth || 320,
      onSession: (s) => onSession?.(s),
      onError,
      onStart,
    }).catch((e: Error) => setFailed(e.message));
    // Drawn once: Google's button keeps its own state from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="auth__gis">
      <div ref={box} className="auth__gis-box" />
      {failed && <p className="auth__gis-error">{failed}</p>}
    </div>
  );
}
