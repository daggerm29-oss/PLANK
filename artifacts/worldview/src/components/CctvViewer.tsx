import { useEffect, useRef, useState } from "react";
import { frameUrl, proxiedImage, type CctvCamera } from "../lib/cctv";

const MONO = "'Share Tech Mono','Courier New',monospace";

const POLL_MS = 1000;
const OFFLINE_AFTER_FAILURES = 5;

/**
 * Near-live still feed: asks the api-server for the camera's newest frame every
 * second (one request at a time), keeps showing the last good frame through
 * transient errors, and only reports "offline" after repeated failures.
 */
function RefreshingImage({ cameraId, upstreamSec }: { cameraId: string; upstreamSec: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [changedAt, setChangedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let objectUrl: string | null = null;
    let lastHash = "";
    let failures = 0;

    setSrc(null);
    setOffline(false);
    setChangedAt(null);

    const tick = async () => {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const started = Date.now();
      controller = new AbortController();
      try {
        const res = await fetch(frameUrl(cameraId, started), { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const hash = res.headers.get("X-Frame-Hash") ?? "";
        const blob = await res.blob();
        if (stopped) return;
        failures = 0;
        setOffline(false);
        if (!hash || hash !== lastHash) {
          lastHash = hash;
          const next = URL.createObjectURL(blob);
          setSrc(next);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          setChangedAt(Date.now());
        }
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= OFFLINE_AFTER_FAILURES) setOffline(true);
      }
      setNow(Date.now());
      if (!stopped) timer = setTimeout(tick, Math.max(0, POLL_MS - (Date.now() - started)));
    };

    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cameraId]);

  const age = changedAt ? Math.max(0, Math.round((now - changedAt) / 1000)) : null;

  return (
    <>
      {src && (
        <img
          src={src}
          alt="Live camera frame"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: offline ? 0.35 : 1 }}
        />
      )}
      {!src && !offline && <Connecting />}
      {offline && <Offline />}
      <Tag color={offline ? "#ff9500" : "#00ffff"}>
        {offline
          ? "● RECONNECTING…"
          : age === null
            ? "● CHECKING SOURCE…"
            : `● SNAPSHOT CAM · new picture every ~${upstreamSec}s · this one is ${age}s old${
                age > upstreamSec * 1.5 ? " · waiting for source" : ""
              }`}
      </Tag>
    </>
  );
}

function Connecting() {
  return (
    <div
      style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        color: "rgba(0,255,255,0.7)", fontSize: 11, letterSpacing: 2, background: "#05080c",
      }}
    >
      ACQUIRING FEED…
    </div>
  );
}

function HlsPlayer({ url, fallback }: { url: string; fallback: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const fail = () => fallbackRef.current();
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;

    {
      // hls.js first: Chrome 142+ reports native HLS support but is stricter than hls.js about live TS streams.
      import("hls.js")
        .then(({ default: Hls }) => {
          if (cancelled) return;
          if (!Hls.isSupported()) {
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = url;
              video.play().catch(() => {});
              return;
            }
            return fail();
          }
          const instance = new Hls({
            lowLatencyMode: false,
            liveSyncDurationCount: 2,
            manifestLoadingMaxRetry: 3,
            levelLoadingMaxRetry: 3,
            fragLoadingMaxRetry: 4,
            maxBufferLength: 10,
          });
          let recoveries = 0;
          instance.loadSource(url);
          instance.attachMedia(video);
          instance.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          instance.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            if (recoveries < 3) {
              recoveries += 1;
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) return instance.startLoad();
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return instance.recoverMediaError();
            }
            instance.destroy();
            fail();
          });
          hls = instance;
        })
        .catch(fail);
    }
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [url]);

  return (
    <>
      <video
        ref={ref}
        muted
        autoPlay
        playsInline
        controls
        style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000" }}
      />
      <Tag color="#ff3b30">● LIVE · HLS</Tag>
    </>
  );
}

function Tag({ children, color = "#00ffff" }: { children: React.ReactNode; color?: string }) {
  return (
    <div
      style={{
        position: "absolute", left: 6, bottom: 6, padding: "2px 6px", fontSize: 9, letterSpacing: 1,
        background: "rgba(0,0,0,0.7)", color, border: `1px solid ${color}55`, pointerEvents: "none",
      }}
    >
      {children}
    </div>
  );
}

function Offline() {
  return (
    <div
      style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        color: "#ff9500", fontSize: 11, letterSpacing: 2, background: "#05080c",
      }}
    >
      FEED OFFLINE
    </div>
  );
}

export function CctvViewer({ camera }: { camera: CctvCamera }) {
  const [hlsFailed, setHlsFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setHlsFailed(false);
    setVideoFailed(false);
  }, [camera.id]);

  const useHls = !!camera.hlsUrl && !hlsFailed;
  const useVideo = !useHls && !!camera.videoUrl && !videoFailed;
  const hasImage = !!camera.imageUrl;

  return (
    <div style={{ fontFamily: MONO, color: "#bff" }}>
      <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", background: "#02050a", border: "1px solid rgba(0,255,255,0.2)" }}>
        {camera.kind === "location" ? (
          <div style={{ padding: 14, fontSize: 11, lineHeight: 1.6, color: "#fb923c" }}>
            OpenStreetMap-mapped surveillance camera. Only the location is public — there is no live feed for this one.
          </div>
        ) : useHls ? (
          <HlsPlayer key={camera.hlsUrl} url={camera.hlsUrl!} fallback={() => setHlsFailed(true)} />
        ) : useVideo ? (
          <>
            <video
              key={camera.videoUrl}
              src={camera.videoUrl}
              poster={camera.imageUrl ? proxiedImage(camera.imageUrl) : undefined}
              muted autoPlay loop playsInline controls
              onError={() => setVideoFailed(true)}
              style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000" }}
            />
            <Tag color="#ff9500">● NOT LIVE · REPLAY LOOP OF RECENT MINUTES (TfL publishes clips)</Tag>
          </>
        ) : hasImage ? (
          <RefreshingImage key={camera.id} cameraId={camera.id} upstreamSec={camera.refreshSec ?? 30} />
        ) : (
          <Offline />
        )}
      </div>
      <div style={{ padding: "8px 2px 2px", fontSize: 11 }}>
        <div style={{ color: "#fff", fontSize: 12, letterSpacing: 0.5 }}>{camera.name}</div>
        <div style={{ color: "rgba(0,255,255,0.7)", marginTop: 2 }}>
          {[camera.area, camera.direction && `facing ${camera.direction}`].filter(Boolean).join(" · ") || camera.source.toUpperCase()}
        </div>
        <div style={{ color: "rgba(180,200,210,0.6)", marginTop: 2 }}>
          {camera.lat.toFixed(5)}, {camera.lon.toFixed(5)}
        </div>
      </div>
    </div>
  );
}
