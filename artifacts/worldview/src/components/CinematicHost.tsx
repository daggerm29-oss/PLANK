import { useEffect, useState } from "react";
import { CinematicTracker } from "./CinematicTracker";
import type { FollowTarget } from "../lib/tracked-entity";
import type { VisionMode } from "../lib/vision-modes";

/**
 * Keeps the last known target mounted while the tracker pulls back and fades
 * out, so exiting 3D view is a graceful zoom-out rather than a hard cut.
 */
export function CinematicHost({ target, visionMode }: { target: FollowTarget | null; visionMode: VisionMode }) {
  const [shown, setShown] = useState<FollowTarget | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (target) {
      setShown(target);
      setExiting(false);
    } else if (shown) {
      setExiting(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (!shown) return null;
  return (
    <CinematicTracker
      key={`${shown.kind}:${shown.id}`}
      target={shown}
      visionMode={visionMode}
      exiting={exiting}
      onExited={() => {
        setShown(null);
        setExiting(false);
      }}
    />
  );
}
