import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

interface Props {
  modelUrl: string;
  headingRef: React.MutableRefObject<number>;
  bearingRef: React.MutableRefObject<number>;
  pitchRef: React.MutableRefObject<number>;
}

export function CinematicOverlay({ modelUrl, headingRef, bearingRef, pitchRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const getSize = () => ({
      w: container.clientWidth || window.innerWidth,
      h: container.clientHeight || window.innerHeight,
    });
    const { w, h } = getSize();

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 5000);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(5, 10, 7);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x99ccff, 0.7);
    fill.position.set(-8, 4, -3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xff8855, 0.4);
    rim.position.set(0, -5, -10);
    scene.add(rim);

    // planeGroup rotates with (heading - bearing) so the plane stays world-aligned
    // as the map bearing changes.
    const planeGroup = new THREE.Group();
    scene.add(planeGroup);

    // inner adjusts the GLB's intrinsic axes so nose points toward world -Z (north).
    const inner = new THREE.Group();
    inner.rotation.y = Math.PI; // flip 180° — these GLBs ship with nose along +Z; we want -Z so heading=0 → north
    planeGroup.add(inner);

    const CAM_DIST = 110;

    let cancelled = false;
    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
      (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const TARGET = 70;
        const s = TARGET / maxDim;
        model.scale.setScalar(s);
        const center = new THREE.Vector3();
        box.getCenter(center);
        model.position.sub(center.multiplyScalar(s));
        inner.add(model);
      },
      undefined,
      (err) => {
        console.error("Failed to load model", modelUrl, err);
      }
    );

    let raf = 0;
    const tick = () => {
      const heading = headingRef.current ?? 0;
      const bearing = bearingRef.current ?? 0;
      const pitch = pitchRef.current ?? 0;

      // Plane stays aligned with the world: as bearing increases (camera rotates clockwise around target),
      // the plane visually rotates by -bearing too, so we add bearing back to keep its world heading.
      planeGroup.rotation.y = -(heading - bearing) * Math.PI / 180;

      // Camera elevation matches map pitch:
      //   pitch =  0 → top-down (camera straight above on +Y)
      //   pitch = 85 → near-horizontal (camera near +Z plane, low above ground)
      const pitchRad = pitch * Math.PI / 180;
      const y = CAM_DIST * Math.cos(pitchRad);
      const z = CAM_DIST * Math.sin(pitchRad);
      camera.position.set(0, Math.max(y, 0.5), Math.max(z, 0.5));
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => {
      const { w: w2, h: h2 } = getSize();
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      try { container.removeChild(renderer.domElement); } catch { /* ignore */ }
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
    };
  }, [modelUrl, headingRef, bearingRef, pitchRef]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 4,
        pointerEvents: "none",
      }}
    />
  );
}
