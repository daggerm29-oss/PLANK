import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type maplibregl from "maplibre-gl";
import { VISION_BY_ID, type FlirPalette, type VisionMode } from "../lib/vision-modes";

const MONO = "'Share Tech Mono','Courier New',monospace";

let noiseUrl: string | null = null;
function getNoiseUrl(): string {
  if (noiseUrl) return noiseUrl;
  const size = 192;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  noiseUrl = c.toDataURL("image/png");
  return noiseUrl;
}

const layer: CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };

function Grain({ opacity, blend = "overlay", fps = 12 }: { opacity: number; blend?: CSSProperties["mixBlendMode"]; fps?: number }) {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(getNoiseUrl()), []);
  if (!url) return null;
  return (
    <div
      data-vision-anim
      style={{
        ...layer,
        inset: "-50%",
        backgroundImage: `url(${url})`,
        backgroundSize: "192px 192px",
        opacity,
        mixBlendMode: blend,
        animation: `vision-grain ${8 / fps}s steps(8) infinite`,
      }}
    />
  );
}

interface Flake {
  x: number;
  y: number;
  r: number;
  speed: number;
  drift: number;
  phase: number;
  alpha: number;
}

function SnowFall() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const count = Math.round(Math.min(420, (w * h) / 4500));
    const flakes: Flake[] = Array.from({ length: count }, () => {
      const depth = Math.random();
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + depth * depth * 3.2,
        speed: 22 + depth * 90,
        drift: 8 + depth * 28,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.35 + depth * 0.6,
      };
    });
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#ffffff";
      for (const f of flakes) {
        f.y += f.speed * dt;
        f.phase += dt * 0.9;
        f.x += Math.sin(f.phase) * f.drift * dt + 14 * dt;
        if (f.y > h + 6) {
          f.y = -6;
          f.x = Math.random() * w;
        }
        if (f.x > w + 6) f.x = -6;
        ctx.globalAlpha = f.alpha;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return <canvas ref={ref} style={{ ...layer, width: "100%", height: "100%", filter: "blur(0.4px)" }} />;
}

function useMapView(map: maplibregl.Map | null) {
  const [view, setView] = useState({ lat: 0, lon: 0, zoom: 2 });
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const c = map.getCenter();
      setView({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    };
    const onMove = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    map.on("move", onMove);
    return () => {
      map.off("move", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [map]);
  return view;
}

function useUtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function fmtCoord(v: number, pos: string, neg: string) {
  return `${Math.abs(v).toFixed(4)}°${v >= 0 ? pos : neg}`;
}

function groundSampleM(lat: number, zoom: number) {
  return (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function HudText({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        position: "absolute",
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function CornerBrackets({ color, inset = 70, size = 26 }: { color: string; inset?: number; size?: number }) {
  const b = `1.5px solid ${color}`;
  const base: CSSProperties = { position: "absolute", width: size, height: size };
  return (
    <>
      <div style={{ ...base, top: inset, left: inset, borderTop: b, borderLeft: b }} />
      <div style={{ ...base, top: inset, right: inset, borderTop: b, borderRight: b }} />
      <div style={{ ...base, bottom: inset, left: inset, borderBottom: b, borderLeft: b }} />
      <div style={{ ...base, bottom: inset, right: inset, borderBottom: b, borderRight: b }} />
    </>
  );
}

function Reticle({ color, size = 120 }: { color: string; size?: number }) {
  const gap = size * 0.18;
  const arm = (size - gap * 2) / 2;
  const bar = (s: CSSProperties) => <div style={{ position: "absolute", background: color, ...s }} />;
  return (
    <div style={{ position: "absolute", left: "50%", top: "50%", width: size, height: size, transform: "translate(-50%,-50%)" }}>
      {bar({ left: 0, top: "50%", width: arm, height: 1.5, transform: "translateY(-50%)" })}
      {bar({ right: 0, top: "50%", width: arm, height: 1.5, transform: "translateY(-50%)" })}
      {bar({ top: 0, left: "50%", height: arm, width: 1.5, transform: "translateX(-50%)" })}
      {bar({ bottom: 0, left: "50%", height: arm, width: 1.5, transform: "translateX(-50%)" })}
      <div style={{ position: "absolute", inset: size * 0.36, border: `1.5px solid ${color}` }} />
    </div>
  );
}

const PALETTE_GRADIENT: Record<FlirPalette, string> = {
  whot: "linear-gradient(to top, #050505, #ffffff)",
  bhot: "linear-gradient(to top, #f2f2f2, #0a0a0a)",
  iron: "linear-gradient(to top, #000010, #2a005c, #80008c, #d6302e, #fa8500, #ffd640, #ffffe6)",
};

function FlirHud({ palette, zoom }: { palette: FlirPalette; zoom: number }) {
  const c = "rgba(255,255,255,0.85)";
  const fov = zoom > 12 ? "NFOV" : zoom > 7 ? "MFOV" : "WFOV";
  return (
    <>
      <Reticle color={c} />
      <CornerBrackets color="rgba(255,255,255,0.55)" />
      <HudText style={{ bottom: 112, left: "50%", transform: "translateX(-50%)", color: c }}>FLIR · {palette.toUpperCase()} · {fov}</HudText>
      <HudText style={{ bottom: 95, left: "50%", transform: "translateX(-50%)", color: "rgba(255,255,255,0.55)" }}>LWIR 8–12µm · NUC OK</HudText>
      <HudText style={{ bottom: 78, left: "50%", transform: "translateX(-50%)", color: c }}>
        ZOOM {(1 + Math.max(0, zoom - 2) * 2.4).toFixed(1)}X · AGC AUTO
      </HudText>
      <div
        style={{
          position: "absolute",
          right: 96,
          top: "50%",
          width: 10,
          height: 180,
          transform: "translateY(-50%)",
          background: PALETTE_GRADIENT[palette],
          border: "1px solid rgba(255,255,255,0.5)",
        }}
      />
      <HudText style={{ right: 112, top: "calc(50% - 98px)", color: c, fontSize: 9 }}>HOT</HudText>
      <HudText style={{ right: 112, top: "calc(50% + 88px)", color: c, fontSize: 9 }}>COLD</HudText>
    </>
  );
}

function SatelliteHud({ lat, lon, zoom }: { lat: number; lon: number; zoom: number }) {
  const now = useUtcClock();
  const c = "rgba(220,255,230,0.9)";
  const gsd = groundSampleM(lat, zoom);
  const gsdText = gsd >= 1000 ? `${(gsd / 1000).toFixed(1)} KM` : `${gsd.toFixed(gsd < 10 ? 2 : 0)} M`;
  return (
    <>
      <div
        style={{
          ...layer,
          backgroundImage:
            "linear-gradient(rgba(220,255,230,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(220,255,230,0.07) 1px, transparent 1px)",
          backgroundSize: "128px 128px",
          backgroundPosition: "center center",
        }}
      />
      <Reticle color="rgba(220,255,230,0.75)" size={64} />
      <CornerBrackets color="rgba(220,255,230,0.6)" inset={64} size={34} />
      <HudText style={{ bottom: 129, left: "50%", transform: "translateX(-50%)", color: c }}>KH-11 // EO PAN-SHARPENED</HudText>
      <HudText style={{ bottom: 112, left: "50%", transform: "translateX(-50%)", color: "rgba(220,255,230,0.6)" }}>ORBIT 617 KM · GSD {gsdText}</HudText>
      <HudText style={{ bottom: 95, left: "50%", transform: "translateX(-50%)", color: c }}>{now.toISOString().replace("T", " ").slice(0, 19)}Z</HudText>
      <HudText style={{ bottom: 72, left: "50%", transform: "translateX(-50%)", color: c }}>
        {fmtCoord(lat, "N", "S")} {fmtCoord(lon, "E", "W")}
      </HudText>
    </>
  );
}

function NvgHud() {
  const c = "rgba(170,255,150,0.85)";
  const glow = "0 0 6px rgba(120,255,100,0.7)";
  return (
    <>
      <HudText style={{ bottom: 95, left: "50%", transform: "translateX(-50%)", color: c, textShadow: glow }}>NVG · GEN III · AUTO-GAIN</HudText>
      <HudText style={{ bottom: 78, left: "50%", transform: "translateX(-50%)", color: c, textShadow: glow }}>
        IR ILLUM OFF · BATT 87%
      </HudText>
    </>
  );
}

function CrtHud() {
  const now = useUtcClock();
  const glow = "0 0 6px rgba(255,200,120,0.8)";
  return (
    <HudText style={{ bottom: 78, left: "50%", transform: "translateX(-50%)", color: "rgba(255,240,200,0.9)", fontSize: 14, textShadow: glow }}>
      CH 03{"  "}
      <span style={{ color: "#ff4d4d", textShadow: "0 0 6px rgba(255,60,60,0.8)", animation: "vision-blink 1.2s steps(2) infinite" }}>● REC</span>
      {"  "}
      {now.toISOString().slice(11, 19)}
    </HudText>
  );
}

export function VisionOverlay({
  mode,
  flirPalette,
  map,
  tracking,
}: {
  mode: VisionMode;
  flirPalette: FlirPalette;
  map: maplibregl.Map | null;
  tracking: boolean;
}) {
  const view = useMapView(map);
  if (mode === "tactical") return null;
  const showHud = !tracking;

  return (
    <div aria-hidden="true" style={{ ...layer, zIndex: 4, overflow: "hidden" }}>
      <style>{`
        @keyframes vision-grain { 0%{transform:translate(0,0)} 12%{transform:translate(-6%,4%)} 25%{transform:translate(5%,-7%)} 37%{transform:translate(-9%,-2%)} 50%{transform:translate(7%,6%)} 62%{transform:translate(-3%,9%)} 75%{transform:translate(9%,-4%)} 87%{transform:translate(-7%,-8%)} 100%{transform:translate(0,0)} }
        @keyframes vision-flicker { 0%,48%,52%,100%{opacity:0} 50%{opacity:.06} 80%{opacity:.03} }
        @keyframes vision-roll { 0%{transform:translateY(-30%)} 100%{transform:translateY(130vh)} }
        @keyframes vision-blink { 0%{opacity:1} 50%{opacity:0} }
        @media (prefers-reduced-motion: reduce) { [data-vision-anim] { animation: none !important; } }
      `}</style>

      {mode === "normal" && (
        <div style={{ ...layer, background: "radial-gradient(ellipse at center, transparent 65%, rgba(0,0,0,0.28) 100%)" }} />
      )}

      {mode === "nvg" && (
        <>
          <Grain opacity={0.22} blend="screen" fps={24} />
          <div style={{ ...layer, background: "radial-gradient(circle at 50% 50%, transparent 52%, rgba(0,12,0,0.55) 72%, rgba(0,0,0,0.92) 92%)" }} />
          <div data-vision-anim style={{ ...layer, background: "rgb(150,255,130)", mixBlendMode: "overlay", animation: "vision-flicker 3.2s infinite" }} />
          {showHud && <NvgHud />}
        </>
      )}

      {mode === "flir" && (
        <>
          <Grain opacity={0.12} blend="overlay" fps={24} />
          <div style={{ ...layer, background: "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.45) 100%)" }} />
          {showHud && <FlirHud palette={flirPalette} zoom={view.zoom} />}
        </>
      )}

      {mode === "crt" && (
        <>
          <div style={{ ...layer, backgroundImage: "repeating-linear-gradient(to bottom, rgba(0,0,0,0.32) 0px, rgba(0,0,0,0.32) 1px, transparent 1px, transparent 3px)" }} />
          <div
            style={{
              ...layer,
              backgroundImage:
                "repeating-linear-gradient(to right, rgba(255,40,40,0.09) 0px, rgba(255,40,40,0.09) 1px, rgba(40,255,40,0.09) 1px, rgba(40,255,40,0.09) 2px, rgba(40,80,255,0.09) 2px, rgba(40,80,255,0.09) 3px)",
              mixBlendMode: "multiply",
            }}
          />
          <div
            data-vision-anim
            style={{ ...layer, bottom: "auto", height: "18vh", background: "linear-gradient(to bottom, transparent, rgba(255,255,255,0.05), transparent)", animation: "vision-roll 7s linear infinite" }}
          />
          <div data-vision-anim style={{ ...layer, background: "#fff", mixBlendMode: "overlay", animation: "vision-flicker 0.18s infinite" }} />
          <Grain opacity={0.08} blend="overlay" fps={30} />
          <div style={{ ...layer, borderRadius: "3.5% / 5%", boxShadow: "inset 0 0 120px 30px rgba(0,0,0,0.85), 0 0 0 40px #000" }} />
          {showHud && <CrtHud />}
        </>
      )}

      {mode === "anime" && (
        <>
          <div style={{ ...layer, background: "radial-gradient(ellipse at 18% 8%, rgba(255,236,190,0.28), transparent 55%)", mixBlendMode: "screen" }} />
          <div style={{ ...layer, background: "linear-gradient(180deg, rgba(120,170,255,0.12), transparent 40%, rgba(255,140,190,0.08))", mixBlendMode: "soft-light" }} />
        </>
      )}

      {mode === "noir" && (
        <>
          <Grain opacity={0.2} blend="overlay" fps={18} />
          <div style={{ ...layer, background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.78) 100%)" }} />
          <div data-vision-anim style={{ ...layer, background: "#fff", mixBlendMode: "overlay", animation: "vision-flicker 0.9s infinite" }} />
        </>
      )}

      {mode === "snow" && (
        <>
          <div style={{ ...layer, background: "linear-gradient(180deg, rgba(225,238,255,0.22), rgba(225,238,255,0.06) 60%, rgba(225,238,255,0.18))" }} />
          <SnowFall />
          <div style={{ ...layer, background: "radial-gradient(ellipse at center, transparent 55%, rgba(235,245,255,0.55) 100%)" }} />
        </>
      )}

      {mode === "satellite" && (
        <>
          <Grain opacity={0.06} blend="overlay" fps={6} />
          {showHud && <SatelliteHud lat={view.lat} lon={view.lon} zoom={view.zoom} />}
        </>
      )}

      <span className="sr-only">{VISION_BY_ID[mode].label} vision mode active</span>
    </div>
  );
}
