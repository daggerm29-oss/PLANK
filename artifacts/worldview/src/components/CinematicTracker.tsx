import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { MODEL_GEOMETRY, type TrackKind, type FollowTarget } from "../lib/tracked-entity";
import type { VisionMode } from "../lib/vision-modes";
import { createOcean, createSpray, createSprayImage, OCEAN_BASE_HEIGHT } from "../lib/ocean-shader";
import { createOrbitPath, type OrbitPath } from "../lib/orbit-path";
import { CinematicZoomControl } from "./CinematicZoomControl";

const ION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0YjdkMmFmMS04ZmU2LTQ4NDYtYTIwMS1hOTg5NGM2NzEzNGYiLCJpZCI6Mzk3MjQyLCJpYXQiOjE3NzI1Mzk5NDV9.sQ4V9RmCN2-xnXW2WZDxSAgaZTZFn9pohwFD9YzmWoU";

Cesium.Ion.defaultAccessToken = ION_TOKEN;

const EARTH_R = 6378137;
const M_PER_DEG = (Math.PI / 180) * EARTH_R;
const INTRO_RANGE = 600_000;
const EXIT_MS = 1500;
const MAX_EXTRAPOLATE_S = 60;
/** Ships and satellites are framed from the rear quarter so the wake / orbit path reads clearly. */
const VIEW_YAW: Record<TrackKind, number> = { aircraft: 0, ship: 0.75, satellite: 0.65 };

const KIND_CONFIG: Record<
  TrackKind,
  {
    range: number;
    pitch: number;
    scale: number;
    minPixel: number;
    maxScale: number;
    minRange: number;
    maxRange: number;
    headingTau: number;
    correctionTau: number;
    sampleSurface: boolean;
  }
> = {
  aircraft: { range: 200, pitch: -0.3, scale: 34, minPixel: 40, maxScale: 500, minRange: 25, maxRange: 8_000_000, headingTau: 1.2, correctionTau: 2.5, sampleSurface: false },
  ship: { range: 380, pitch: -0.24, scale: 60, minPixel: 60, maxScale: 400, minRange: 60, maxRange: 8_000_000, headingTau: 2.5, correctionTau: 3, sampleSurface: true },
  satellite: { range: 90, pitch: -0.42, scale: 6, minPixel: 110, maxScale: 60, minRange: 15, maxRange: 20_000_000, headingTau: 0.6, correctionTau: 0.8, sampleSurface: false },
};

// Cesium Ion serves Google Photorealistic 3D Tiles under its own licence, so it
// works without a billed Google Cloud project. A direct Google key is only a fallback.
async function loadGoogleTileset(): Promise<Cesium.Cesium3DTileset> {
  try {
    return await Cesium.createGooglePhotorealistic3DTileset();
  } catch (e) {
    console.error("Cesium Ion Google tiles failed, trying direct Google key", e);
  }
  const res = await fetch("/api/config/google-tiles");
  if (!res.ok) throw new Error("No Google tiles key configured");
  const { key } = (await res.json()) as { key: string };
  return Cesium.Cesium3DTileset.fromUrl(
    `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`,
    { showCreditsOnScreen: true },
  );
}

// Tints Google 3D tiles into a dark blue/cyan night-vision look.
const TILESET_NIGHT_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.UNLIT,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      vec3 c = material.diffuse;
      float gray = dot(c, vec3(0.299, 0.587, 0.114));
      gray = pow(gray, 1.6) * 0.55;
      material.diffuse = vec3(gray * 0.18, gray * 0.78, gray * 1.0);
      material.alpha = 1.0;
    }
  `,
});

interface Props {
  target: FollowTarget;
  visionMode: VisionMode;
  exiting?: boolean;
  onExited?: () => void;
}

interface VisionHandles {
  viewer: Cesium.Viewer;
  tileset: Cesium.Cesium3DTileset | null;
  osm: Cesium.ImageryLayer | null;
  esri: Cesium.ImageryLayer | null;
  model: Cesium.Model | null;
  nightTiles: boolean;
  ocean: boolean;
}

// Matches the 2D icon overrides in vision-modes.ts: the model is the hottest / brightest
// object in sensor modes, dark against white in Snow, ink-outlined in Anime.
const MODEL_VISION: Partial<Record<VisionMode, { color?: string; mix?: number; silhouette?: string; silhouetteSize?: number }>> = {
  nvg: { color: "#ffffff", mix: 0.55 },
  flir: { color: "#ffff00", mix: 0.9 },
  noir: { color: "#ffffff", mix: 0.4, silhouette: "#000000", silhouetteSize: 1 },
  snow: { color: "#0a0f1c", mix: 0.65 },
  anime: { silhouette: "#14081a", silhouetteSize: 2.5 },
  crt: { silhouette: "#000000", silhouetteSize: 1 },
};

function applyModelVision(model: Cesium.Model, mode: VisionMode) {
  if (model.isDestroyed()) return;
  const v = MODEL_VISION[mode];
  if (v?.color) {
    model.color = Cesium.Color.fromCssColorString(v.color);
    model.colorBlendMode = Cesium.ColorBlendMode.MIX;
    model.colorBlendAmount = v.mix ?? 0.5;
  } else {
    model.color = Cesium.Color.WHITE;
    model.colorBlendMode = Cesium.ColorBlendMode.HIGHLIGHT;
    model.colorBlendAmount = 0;
  }
  model.silhouetteColor = Cesium.Color.fromCssColorString(v?.silhouette ?? "#000000");
  model.silhouetteSize = v?.silhouette ? v.silhouetteSize ?? 1 : 0;
}

/**
 * Vision grading itself is a CSS/SVG filter on the shared world stack (so tiles and
 * models match the 2D map). Here we only pick the right source look: the night tile
 * shader for Tactical, true-colour tiles + Esri imagery globe for every other mode.
 */
function applyCesiumVision(h: VisionHandles, mode: VisionMode) {
  if (h.viewer.isDestroyed()) return;
  const tactical = mode === "tactical";
  const scene = h.viewer.scene;
  if (h.tileset) h.tileset.customShader = tactical && h.nightTiles ? TILESET_NIGHT_SHADER : undefined;
  if (h.osm) h.osm.show = tactical;
  if (h.esri) h.esri.show = !tactical && !h.ocean;
  if (h.ocean && h.osm) h.osm.show = false;
  scene.globe.baseColor = Cesium.Color.fromCssColorString(h.ocean ? "#010509" : tactical ? "#031626" : "#0b2233");
  scene.backgroundColor = Cesium.Color.fromCssColorString(tactical ? "#000000" : "#02060c");
  if (h.model) applyModelVision(h.model, mode);
}

interface Motion {
  lon: number;
  lat: number;
  alt: number;
  heading: number;
  speed: number;
}

/** Offsets a lon/lat by metres east/north. */
function offsetDeg(lat: number, east: number, north: number): { dLon: number; dLat: number } {
  const cosLat = Math.max(Math.cos(Cesium.Math.toRadians(lat)), 0.01);
  return { dLon: east / (M_PER_DEG * cosLat), dLat: north / M_PER_DEG };
}

function sampleKey(t: FollowTarget): string {
  return `${t.lat}|${t.lon}|${t.altM}|${t.headingDeg}|${t.speedMs}`;
}

export function CinematicTracker({ target, visionMode, exiting = false, onExited }: Props) {
  const visionRef = useRef(visionMode);
  visionRef.current = visionMode;
  const handlesRef = useRef<VisionHandles | null>(null);
  useEffect(() => {
    if (handlesRef.current) applyCesiumVision(handlesRef.current, visionMode);
  }, [visionMode]);
  const kind = target.kind;
  const cfg = KIND_CONFIG[kind];
  const geometry: { headingOffsetDeg: number; keelDepth: number; scale?: number } =
    MODEL_GEOMETRY[target.modelUrl.split("/").pop() ?? ""] ?? { headingOffsetDeg: 0, keelDepth: 0 };
  const modelScale = geometry.scale ?? cfg.scale;
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<FollowTarget>(target);
  const sampleKeyRef = useRef<string>("");
  const sampleTimeRef = useRef<number>(performance.now());
  const motionRef = useRef<Motion | null>(null);
  const camRef = useRef({
    yaw: VIEW_YAW[kind],
    pitch: cfg.pitch,
    logRange: Math.log(INTRO_RANGE),
    logTarget: Math.log(cfg.range),
  });
  const [visible, setVisible] = useState(false);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // The parent re-creates `target` on every render; only a changed position/velocity
  // is a new sample. Treating every render as a sample made the model snap backwards.
  useEffect(() => {
    targetRef.current = target;
    if (target.lat === undefined || target.lon === undefined) return;
    const key = sampleKey(target);
    if (key === sampleKeyRef.current) return;
    sampleKeyRef.current = key;
    sampleTimeRef.current = performance.now() - Math.min(target.sampleAgeSec ?? 0, 15) * 1000;
    if (motionRef.current === null) {
      motionRef.current = {
        lon: target.lon,
        lat: target.lat,
        alt: target.altM ?? 0,
        heading: target.headingDeg ?? 0,
        speed: target.speedMs ?? 0,
      };
    }
  }, [target]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Graceful exit: pull the camera back up, fade, then notify the parent.
  useEffect(() => {
    if (!exiting) return;
    camRef.current.logTarget = Math.log(INTRO_RANGE);
    const fade = setTimeout(() => setVisible(false), EXIT_MS * 0.45);
    const done = setTimeout(() => onExitedRef.current?.(), EXIT_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [exiting]);

  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  /** Log-space zoom; negative delta moves the camera closer. Shared by wheel, keys and the HUD. */
  const zoomBy = (delta: number) => {
    if (exitingRef.current) return;
    const cam = camRef.current;
    cam.logTarget = Math.max(Math.log(cfg.minRange), Math.min(Math.log(cfg.maxRange), cam.logTarget + delta));
  };
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  const resetView = () => {
    if (exitingRef.current) return;
    camRef.current.logTarget = Math.log(cfg.range);
    camRef.current.yaw = VIEW_YAW[kind];
    camRef.current.pitch = cfg.pitch;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let viewer: Cesium.Viewer | null = null;
    const cleanups: Array<() => void> = [];

    try {
      viewer = new Cesium.Viewer(container, {
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        navigationInstructionsInitiallyVisible: false,
        baseLayer: false,
      });

      const v = viewer;
      const scene = v.scene;
      scene.backgroundColor = Cesium.Color.BLACK;
      // The globe is visible until the photorealistic tiles arrive so the view is never empty.
      scene.globe.show = true;
      scene.globe.baseColor = Cesium.Color.fromCssColorString("#031626");
      scene.fog.enabled = false;
      if (scene.sun) scene.sun.show = true;
      if (scene.moon) scene.moon.show = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = kind === "satellite";
      scene.screenSpaceCameraController.enableInputs = false;

      const fixedTime = Cesium.JulianDate.fromIso8601("2024-06-15T22:30:00Z");
      v.clock.startTime = fixedTime.clone();
      v.clock.currentTime = fixedTime.clone();
      v.clock.stopTime = fixedTime.clone();
      if (kind === "ship") {
        // Particle systems integrate over frame time, so the clock has to run.
        v.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
        v.clock.stopTime = Cesium.JulianDate.addDays(fixedTime, 1, new Cesium.JulianDate());
        v.clock.shouldAnimate = true;
        v.clock.multiplier = 1;
      } else {
        v.clock.clockRange = Cesium.ClockRange.CLAMPED;
        v.clock.shouldAnimate = false;
        v.clock.multiplier = 0;
      }

      const handles: VisionHandles = {
        viewer: v,
        tileset: null,
        osm: null,
        esri: null,
        model: null,
        nightTiles: kind === "aircraft",
        ocean: kind === "ship",
      };
      handlesRef.current = handles;
      if (kind === "ship") {
        if (scene.skyBox) scene.skyBox.show = true;
        if (scene.sun) scene.sun.show = false;
        if (scene.moon) scene.moon.show = false;
      }
      if (kind !== "ship") try {
        const layer = v.imageryLayers.addImageryProvider(
          new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
        );
        layer.brightness = 0.45;
        layer.saturation = 0.5;
        handles.osm = layer;
      } catch (e) {
        console.error("Failed to add imagery", e);
      }
      if (kind !== "ship") try {
        handles.esri = v.imageryLayers.addImageryProvider(
          new Cesium.UrlTemplateImageryProvider({
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            maximumLevel: 19,
            credit: "Imagery © Esri, Maxar, Earthstar Geographics",
          }),
        );
      } catch (e) {
        console.error("Failed to add satellite imagery", e);
      }
      applyCesiumVision(handles, visionRef.current);

      const updateLight = () => {
        if (v.isDestroyed()) return;
        scene.light = new Cesium.DirectionalLight({
          direction: Cesium.Cartesian3.clone(scene.camera.directionWC),
          color: Cesium.Color.WHITE,
          intensity: 2.5,
        });
      };
      updateLight();

      const scratchPos = new Cesium.Cartesian3();
      const computePosition = (): Cesium.Cartesian3 => {
        const m = motionRef.current;
        if (!m) return Cesium.Cartesian3.fromDegrees(0, 0, 0, undefined, scratchPos);
        return Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.alt, undefined, scratchPos);
      };

      // A model primitive (not an entity) so its matrix is set in the same preRender pass
      // as the camera; entities are evaluated a frame earlier, which made the model trail
      // and stutter relative to the camera. Added immediately, before any tiles load.
      let model: Cesium.Model | null = null;
      Cesium.Model.fromGltfAsync({
        url: targetRef.current.modelUrl,
        minimumPixelSize: cfg.minPixel,
        maximumScale: cfg.maxScale,
        scale: modelScale,
        shadows: Cesium.ShadowMode.DISABLED,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        show: false,
      })
        .then((mdl) => {
          if (cancelled || v.isDestroyed()) {
            mdl.destroy();
            return;
          }
          model = scene.primitives.add(mdl) as Cesium.Model;
          handles.model = model;
          applyModelVision(model, visionRef.current);
        })
        .catch((e) => console.error("Failed to load model", e));
      const scratchHpr = new Cesium.HeadingPitchRoll();
      const scratchMatrix = new Cesium.Matrix4();

      // Surface height under the object (sea level from the tiles is at the geoid, not h=0).
      let tileset: Cesium.Cesium3DTileset | null = null;
      const surface = { height: kind === "ship" ? OCEAN_BASE_HEIGHT : 0, pending: false, lastMs: 0 };
      const needsSurface = () => cfg.sampleSurface || (kind === "aircraft" && (targetRef.current.altM ?? 0) < 1500);
      const sampleSurface = () => {
        const m = motionRef.current;
        if (!m || !tileset || surface.pending) return;
        surface.pending = true;
        scene
          .sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(m.lon, m.lat)], model ? [model] : [])
          .then(([c]) => {
            if (c && Number.isFinite(c.height)) surface.height = c.height;
          })
          .catch(() => {})
          .finally(() => {
            surface.pending = false;
            surface.lastMs = performance.now();
          });
      };

      // ---- Ship: procedural tactical ocean + spray instead of the photogrammetry sea ----
      const shipLen = 1.9 * modelScale;
      const shipBeam = shipLen * 0.17;
      let ocean: Awaited<ReturnType<typeof createOcean>> | null = null;
      let bowSpray: Cesium.ParticleSystem | null = null;
      let sternSpray: Cesium.ParticleSystem | null = null;
      let oceanOrigin: { lon: number; lat: number } | null = null;
      const startMs = performance.now();
      if (kind === "ship") {
        createOcean()
          .then((o) => {
            if (cancelled || v.isDestroyed()) {
              o.model.destroy();
              return;
            }
            scene.primitives.add(o.model);
            o.shader.setUniform("u_shipLen", shipLen);
            o.shader.setUniform("u_beam", shipBeam);
            ocean = o;
          })
          .catch((e) => console.error("Failed to build ocean", e));
        const img = createSprayImage();
        bowSpray = scene.primitives.add(createSpray(img, 38, [1.6, 4.8], [4, 10])) as Cesium.ParticleSystem;
        sternSpray = scene.primitives.add(createSpray(img, 65, [1.2, 3.2], [1.5, 4.5])) as Cesium.ParticleSystem;
      }
      const scratchEnu = new Cesium.Matrix4();
      const scratchRot = new Cesium.Matrix4();
      const scratchLocal = new Cesium.Matrix4();
      const scratchTrans = new Cesium.Cartesian3();
      const scratchNorth = new Cesium.Cartesian3();
      const scratchRot3 = new Cesium.Matrix3();
      const placeSpray = (
        ps: Cesium.ParticleSystem | null,
        base: Cesium.Cartesian3,
        headingRad: number,
        forwardM: number,
        upM: number,
        rate: number,
      ) => {
        if (!ps) return;
        Cesium.Transforms.eastNorthUpToFixedFrame(base, undefined, scratchEnu);
        Cesium.Matrix4.fromRotationTranslation(
          Cesium.Matrix3.fromRotationZ(-headingRad, scratchRot3),
          Cesium.Cartesian3.ZERO,
          scratchRot,
        );
        Cesium.Matrix4.multiply(scratchEnu, scratchRot, scratchLocal);
        Cesium.Matrix4.multiplyByTranslation(
          scratchLocal,
          Cesium.Cartesian3.fromElements(0, forwardM, upM, scratchTrans),
          scratchLocal,
        );
        ps.modelMatrix = Cesium.Matrix4.clone(scratchLocal, ps.modelMatrix);
        ps.emissionRate = rate;
        ps.show = true;
      };

      // ---- Satellite: exact SGP4 placement + animated orbital trajectory ----
      let orbit: OrbitPath | null = null;
      if (kind === "satellite" && targetRef.current.ecefAt) {
        orbit = createOrbitPath(
          scene,
          () => targetRef.current.ecefAt,
          () => targetRef.current.orbitPeriodSec,
        );
        cleanups.push(() => orbit?.destroy());
      }
      const scratchSat = new Cesium.Cartesian3();
      const scratchSatNext = new Cesium.Cartesian3();
      const scratchVel = new Cesium.Cartesian3();
      const scratchCarto = new Cesium.Cartographic();
      const exactSatellite = (m: Motion): Cesium.Cartesian3 | null => {
        const fn = targetRef.current.ecefAt;
        if (!fn) return null;
        const nowDate = Date.now();
        const p0 = fn(new Date(nowDate));
        const p1 = fn(new Date(nowDate + 1000));
        if (!p0 || !p1) return null;
        Cesium.Cartesian3.fromElements(p0.x, p0.y, p0.z, scratchSat);
        Cesium.Cartesian3.fromElements(p1.x, p1.y, p1.z, scratchSatNext);
        Cesium.Cartesian3.subtract(scratchSatNext, scratchSat, scratchVel);
        Cesium.Transforms.eastNorthUpToFixedFrame(scratchSat, undefined, scratchEnu);
        const east = Cesium.Cartesian3.fromElements(scratchEnu[0], scratchEnu[1], scratchEnu[2], scratchTrans);
        const north = Cesium.Cartesian3.fromElements(scratchEnu[4], scratchEnu[5], scratchEnu[6], scratchNorth);
        const ve = Cesium.Cartesian3.dot(scratchVel, east);
        const vn = Cesium.Cartesian3.dot(scratchVel, north);
        m.heading = ((Cesium.Math.toDegrees(Math.atan2(ve, vn)) % 360) + 360) % 360;
        const carto = Cesium.Cartographic.fromCartesian(scratchSat, undefined, scratchCarto);
        if (carto) {
          m.lon = Cesium.Math.toDegrees(carto.longitude);
          m.lat = Cesium.Math.toDegrees(carto.latitude);
          m.alt = carto.height;
        }
        return scratchSat;
      };

      if (kind === "aircraft") {
        loadGoogleTileset()
          .then((ts) => {
            if (cancelled || v.isDestroyed()) return;
            scene.primitives.add(ts);
            tileset = ts;
            handles.tileset = ts;
            applyCesiumVision(handles, visionRef.current);
            // Google tiles include the sea surface; hide the globe to avoid z-fighting.
            scene.globe.show = false;
            if (needsSurface()) sampleSurface();
          })
          .catch((e) => console.error("Failed to load Google 3D tileset", e));
      }

      const targetAltitude = (): number => {
        const t = targetRef.current;
        if (kind === "ship") return surface.height + geometry.keelDepth * cfg.scale;
        if (kind === "aircraft") return Math.max(t.altM ?? 0, surface.height + 2);
        return t.altM ?? 0;
      };

      // ---- Per-frame update: velocity integration + smooth error correction ----
      let lastFrameMs = performance.now();

      scene.preRender.addEventListener(() => {
        if (v.isDestroyed()) return;
        updateLight();
        const now = performance.now();
        const dt = Math.min((now - lastFrameMs) / 1000, 0.1);
        lastFrameMs = now;
        const t = targetRef.current;
        const m = motionRef.current;
        if (!m || t.lat === undefined || t.lon === undefined) return;

        if (tileset && needsSurface() && now - surface.lastMs > 5000) sampleSurface();

        const tSpeed = t.speedMs ?? 0;
        const tHeading = t.headingDeg ?? m.heading;

        // Where the latest sample says the object is right now.
        const age = Math.min((now - sampleTimeRef.current) / 1000, MAX_EXTRAPOLATE_S);
        const sampleHdg = Cesium.Math.toRadians(tHeading);
        const ahead = tSpeed * age;
        const pred = offsetDeg(t.lat, ahead * Math.sin(sampleHdg), ahead * Math.cos(sampleHdg));
        const pLat = t.lat + pred.dLat;
        const pLon = t.lon + pred.dLon;

        m.speed += (tSpeed - m.speed) * (1 - Math.exp(-dt / 2));
        const dh = (((tHeading - m.heading + 540) % 360) - 180);
        m.heading = (m.heading + dh * (1 - Math.exp(-dt / cfg.headingTau)) + 360) % 360;

        const satPos = kind === "satellite" ? exactSatellite(m) : null;
        if (satPos) {
          orbit?.update(Date.now(), dt);
          placeModelAndCamera(satPos, Cesium.Math.toRadians(m.heading), dt, 0, 0, 0);
          return;
        }

        const hdg = Cesium.Math.toRadians(m.heading);
        const sinH = Math.sin(hdg);
        const cosH = Math.cos(hdg);
        const cosLat = Math.max(Math.cos(Cesium.Math.toRadians(m.lat)), 0.01);
        const errEast = (pLon - m.lon) * M_PER_DEG * cosLat;
        const errNorth = (pLat - m.lat) * M_PER_DEG;
        const errDist = Math.hypot(errEast, errNorth);

        if (errDist > Math.max(3000, tSpeed * 30)) {
          // Far off (first fix, teleport, feed gap): jump instead of sliding across the map.
          m.lon = pLon;
          m.lat = pLat;
        } else {
          // Move with own velocity, then bleed off the error. The along-track part is
          // clamped so the model never visibly reverses when a sample lags behind.
          const step = m.speed * dt;
          const c = 1 - Math.exp(-dt / cfg.correctionTau);
          const along = errEast * sinH + errNorth * cosH;
          const cross = errEast * cosH - errNorth * sinH;
          const alongCorr = Math.max(along * c, -0.7 * step);
          const crossCorr = cross * c;
          const forward = step + alongCorr;
          const east = forward * sinH + crossCorr * cosH;
          const north = forward * cosH - crossCorr * sinH;
          const o = offsetDeg(m.lat, east, north);
          m.lon += o.dLon;
          m.lat += o.dLat;
        }
        m.alt += (targetAltitude() - m.alt) * (1 - Math.exp(-dt / 1.5));

        const pos = computePosition();
        if (kind === "ship") {
          const ts = (now - startMs) / 1000;
          const heave = 0.45 * Math.sin(ts * 1.05) + 0.25 * Math.sin(ts * 1.7 + 1.1);
          const pitch = Cesium.Math.toRadians(1.1 * Math.sin(ts * 0.8 + 0.4));
          const roll = Cesium.Math.toRadians(2.2 * Math.sin(ts * 0.63 + 0.5));
          if (!oceanOrigin) oceanOrigin = { lon: m.lon, lat: m.lat };
          const cosLat0 = Math.max(Math.cos(Cesium.Math.toRadians(oceanOrigin.lat)), 0.01);
          const oceanBase = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, OCEAN_BASE_HEIGHT);
          if (ocean) {
            ocean.model.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
              oceanBase,
              undefined,
              ocean.model.modelMatrix,
            );
            ocean.shader.setUniform("u_time", ts);
            ocean.shader.setUniform(
              "u_offset",
              new Cesium.Cartesian2(
                (m.lon - oceanOrigin.lon) * M_PER_DEG * cosLat0,
                (m.lat - oceanOrigin.lat) * M_PER_DEG,
              ),
            );
            ocean.shader.setUniform("u_heading", hdg);
            ocean.shader.setUniform("u_speed", m.speed);
            ocean.model.show = true;
          }
          const vis = Math.max(m.speed, 2.5);
          placeSpray(bowSpray, oceanBase, hdg, shipLen * 0.46, 1.5, 70 + vis * 22);
          placeSpray(sternSpray, oceanBase, hdg, -shipLen * 0.45, 0.8, 40 + vis * 12);
          placeModelAndCamera(pos, hdg, dt, heave, pitch, roll);
          return;
        }
        placeModelAndCamera(pos, hdg, dt, 0, 0, 0);
      });

      const scratchModelPos = new Cesium.Cartesian3();
      function placeModelAndCamera(
        pos: Cesium.Cartesian3,
        hdg: number,
        dt: number,
        heave: number,
        pitch: number,
        roll: number,
      ) {
        if (model) {
          const m = motionRef.current;
          let modelPos = pos;
          if (heave !== 0 && m) {
            modelPos = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.alt + heave, undefined, scratchModelPos);
          }
          scratchHpr.heading = hdg + Cesium.Math.toRadians(geometry.headingOffsetDeg);
          scratchHpr.pitch = pitch;
          scratchHpr.roll = roll;
          model.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
            modelPos,
            scratchHpr,
            undefined,
            undefined,
            scratchMatrix,
          );
          model.show = true;
        }
        const cam = camRef.current;
        const rk = 1 - Math.exp(-dt / (exitingRef.current ? 0.45 : 0.5));
        cam.logRange += (cam.logTarget - cam.logRange) * rk;
        scene.camera.lookAt(
          pos,
          new Cesium.HeadingPitchRange(hdg + cam.yaw, cam.pitch, Math.exp(cam.logRange)),
        );
      }

      // ---- Orbit / zoom input ----
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const onDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        container.setPointerCapture?.(e.pointerId);
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging || exitingRef.current) return;
        const cam = camRef.current;
        cam.yaw -= (e.clientX - lastX) * 0.005;
        cam.pitch = Math.max(-1.5, Math.min(0.25, cam.pitch - (e.clientY - lastY) * 0.004));
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onUp = () => {
        dragging = false;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        zoomByRef.current(e.deltaY * 0.001);
      };
      const onKey = (e: KeyboardEvent) => {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        if (e.key === "+" || e.key === "=") zoomByRef.current(-0.35);
        else if (e.key === "-" || e.key === "_") zoomByRef.current(0.35);
      };
      window.addEventListener("keydown", onKey);
      cleanups.push(() => window.removeEventListener("keydown", onKey));
      container.addEventListener("pointerdown", onDown);
      container.addEventListener("pointermove", onMove);
      container.addEventListener("pointerup", onUp);
      container.addEventListener("pointercancel", onUp);
      container.addEventListener("wheel", onWheel, { passive: false });
      cleanups.push(() => {
        container.removeEventListener("pointerdown", onDown);
        container.removeEventListener("pointermove", onMove);
        container.removeEventListener("pointerup", onUp);
        container.removeEventListener("pointercancel", onUp);
        container.removeEventListener("wheel", onWheel);
      });
    } catch (e) {
      console.error("Cesium viewer init failed", e);
    }

    return () => {
      cancelled = true;
      handlesRef.current = null;
      cleanups.forEach((fn) => fn());
      try {
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.modelUrl, kind]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 5,
          background: "#000005",
          opacity: visible ? 1 : 0,
          transition: "opacity 0.7s ease",
          touchAction: "none",
          cursor: "grab",
        }}
      />
      {!exiting &&
        createPortal(
          <CinematicZoomControl
            getRange={() => Math.exp(camRef.current.logTarget)}
            minRange={cfg.minRange}
            maxRange={cfg.maxRange}
            onZoom={zoomBy}
            onReset={resetView}
          />,
          document.body,
        )}
    </>
  );
}
