/**
 * SVG filter chains referenced by `filter: url(#vf-*)` on the world stack.
 * They run on the compositor, so the MapLibre canvas, the orbital satellite
 * canvas and the Cesium photorealistic tiles + 3D models are graded identically.
 */

const LUM = "0.2126 0.7152 0.0722 0 0";
const LUM_MATRIX = `${LUM} ${LUM} ${LUM} 0 0 0 1 0`;

const R_ONLY = "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0";
const G_ONLY = "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0";
const B_ONLY = "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0";

// Daytime thermal approximation from visible light: blue-dominant (water) reads
// cool, bright/sandy/man-made surfaces read warm, vegetation sits in between.
// Entities are recoloured pure yellow by vision-modes.ts, which maps to peak heat.
const HEAT_ROW = "0.55 0.38 -0.42 0 0.06";
const HEAT_MATRIX = `${HEAT_ROW} ${HEAT_ROW} ${HEAT_ROW} 0 0 0 1 0`;

const filterProps = {
  x: "0",
  y: "0",
  width: "1",
  height: "1",
  colorInterpolationFilters: "sRGB" as const,
};

function Bloom({ input, std, gain, result }: { input: string; std: number; gain: number; result: string }) {
  return (
    <>
      <feGaussianBlur in={input} stdDeviation={std} result={`${result}-blur`} />
      <feComponentTransfer in={`${result}-blur`} result={`${result}-glow`}>
        <feFuncR type="linear" slope={gain} />
        <feFuncG type="linear" slope={gain} />
        <feFuncB type="linear" slope={gain} />
      </feComponentTransfer>
      <feBlend in={input} in2={`${result}-glow`} mode="screen" result={result} />
    </>
  );
}

function ThermalBase() {
  return (
    <>
      <feGaussianBlur in="SourceGraphic" stdDeviation="0.7" result="soft" />
      <feColorMatrix in="soft" type="matrix" values={HEAT_MATRIX} result="heat0" />
      <feComponentTransfer in="heat0" result="heat">
        <feFuncR type="linear" slope="1.25" intercept="-0.08" />
        <feFuncG type="linear" slope="1.25" intercept="-0.08" />
        <feFuncB type="linear" slope="1.25" intercept="-0.08" />
      </feComponentTransfer>
    </>
  );
}

export function VisionFilters() {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}>
      <defs>
        {/* NVG — Gen III green phosphor, amplified shadows, soft halo bloom */}
        <filter id="vf-nvg" {...filterProps}>
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.5" result="soft" />
          <feColorMatrix in="soft" type="matrix" values={LUM_MATRIX} result="lum" />
          <feComponentTransfer in="lum" result="amp">
            <feFuncR type="gamma" amplitude="0.82" exponent="1.15" offset="0.02" />
            <feFuncG type="gamma" amplitude="0.82" exponent="1.15" offset="0.02" />
            <feFuncB type="gamma" amplitude="0.82" exponent="1.15" offset="0.02" />
          </feComponentTransfer>
          <feComponentTransfer in="amp" result="phosphor">
            <feFuncR type="table" tableValues="0 0.03 0.1 0.28 0.78" />
            <feFuncG type="table" tableValues="0.01 0.3 0.62 0.9 1" />
            <feFuncB type="table" tableValues="0 0.04 0.1 0.24 0.66" />
          </feComponentTransfer>
          <Bloom input="phosphor" std={3} gain={0.45} result="out" />
        </filter>

        {/* FLIR — white hot */}
        <filter id="vf-flir-whot" {...filterProps}>
          <ThermalBase />
          <Bloom input="heat" std={2} gain={0.3} result="out" />
        </filter>

        {/* FLIR — black hot */}
        <filter id="vf-flir-bhot" {...filterProps}>
          <ThermalBase />
          <feComponentTransfer in="heat" result="inv">
            <feFuncR type="table" tableValues="0.95 0.04" />
            <feFuncG type="table" tableValues="0.95 0.04" />
            <feFuncB type="table" tableValues="0.95 0.04" />
          </feComponentTransfer>
        </filter>

        {/* FLIR — ironbow false colour */}
        <filter id="vf-flir-iron" {...filterProps}>
          <ThermalBase />
          <feComponentTransfer in="heat" result="iron">
            <feFuncR type="table" tableValues="0 0.16 0.5 0.84 0.98 1 1" />
            <feFuncG type="table" tableValues="0 0 0.02 0.18 0.52 0.84 1" />
            <feFuncB type="table" tableValues="0.06 0.36 0.56 0.32 0.02 0.14 0.9" />
          </feComponentTransfer>
          <Bloom input="iron" std={2} gain={0.25} result="out" />
        </filter>

        {/* CRT — RGB convergence error, punchy phosphor colour, glow */}
        <filter id="vf-crt" {...filterProps}>
          <feColorMatrix in="SourceGraphic" type="matrix" values={R_ONLY} result="r0" />
          <feOffset in="r0" dx="-1.4" dy="0" result="r" />
          <feColorMatrix in="SourceGraphic" type="matrix" values={G_ONLY} result="g" />
          <feColorMatrix in="SourceGraphic" type="matrix" values={B_ONLY} result="b0" />
          <feOffset in="b0" dx="1.4" dy="0" result="b" />
          <feBlend in="r" in2="g" mode="screen" result="rg" />
          <feBlend in="rg" in2="b" mode="screen" result="rgb" />
          <feColorMatrix in="rgb" type="saturate" values="1.35" result="sat" />
          <feComponentTransfer in="sat" result="contrast">
            <feFuncR type="linear" slope="1.18" intercept="-0.05" />
            <feFuncG type="linear" slope="1.12" intercept="-0.04" />
            <feFuncB type="linear" slope="1.05" intercept="-0.03" />
          </feComponentTransfer>
          <Bloom input="contrast" std={2.5} gain={0.4} result="out" />
        </filter>

        {/* ANIME — flat painterly cel shading with clean ink outlines */}
        <filter id="vf-anime" {...filterProps}>
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.8" result="soft" />
          <feColorMatrix in="soft" type="saturate" values="1.7" result="vivid" />
          <feComponentTransfer in="vivid" result="bright">
            <feFuncR type="gamma" amplitude="1.08" exponent="0.85" offset="0.02" />
            <feFuncG type="gamma" amplitude="1.08" exponent="0.85" offset="0.02" />
            <feFuncB type="gamma" amplitude="1.1" exponent="0.85" offset="0.04" />
          </feComponentTransfer>
          <feComponentTransfer in="bright" result="paint">
            <feFuncR type="discrete" tableValues="0.1 0.34 0.6 0.84 1" />
            <feFuncG type="discrete" tableValues="0.12 0.36 0.62 0.86 1" />
            <feFuncB type="discrete" tableValues="0.2 0.44 0.68 0.9 1" />
          </feComponentTransfer>
          <feColorMatrix in="SourceGraphic" type="matrix" values={LUM_MATRIX} result="lum" />
          <feGaussianBlur in="lum" stdDeviation="1.1" result="lumSoft" />
          <feConvolveMatrix
            in="lumSoft"
            order="3"
            kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1"
            divisor="1"
            preserveAlpha="true"
            result="edges"
          />
          <feComponentTransfer in="edges" result="ink">
            <feFuncR type="table" tableValues="1 1 0.3 0.1 0.06" />
            <feFuncG type="table" tableValues="1 1 0.28 0.1 0.06" />
            <feFuncB type="table" tableValues="1 1 0.34 0.16 0.12" />
          </feComponentTransfer>
          <feBlend in="paint" in2="ink" mode="multiply" result="cel" />
          <Bloom input="cel" std={5} gain={0.2} result="out" />
        </filter>

        {/* NOIR — high-contrast silver monochrome */}
        <filter id="vf-noir" {...filterProps}>
          <feColorMatrix in="SourceGraphic" type="matrix" values={LUM_MATRIX} result="lum" />
          <feComponentTransfer in="lum" result="curve">
            <feFuncR type="table" tableValues="0 0.015 0.07 0.2 0.44 0.7 0.88 0.97 1" />
            <feFuncG type="table" tableValues="0 0.015 0.07 0.2 0.44 0.7 0.88 0.97 1" />
            <feFuncB type="table" tableValues="0 0.015 0.07 0.2 0.44 0.7 0.88 0.97 1" />
          </feComponentTransfer>
          <Bloom input="curve" std={2.5} gain={0.18} result="out" />
        </filter>

        {/* SNOW — snow-cover whitening with cold blue cast */}
        <filter id="vf-snow" {...filterProps}>
          <feColorMatrix in="SourceGraphic" type="saturate" values="0.28" result="desat" />
          <feComponentTransfer in="desat" result="white">
            <feFuncR type="gamma" amplitude="1.08" exponent="0.55" offset="0.03" />
            <feFuncG type="gamma" amplitude="1.08" exponent="0.55" offset="0.03" />
            <feFuncB type="gamma" amplitude="1.08" exponent="0.55" offset="0.03" />
          </feComponentTransfer>
          <feColorMatrix
            in="white"
            type="matrix"
            values="0.9 0 0 0 0  0 0.96 0 0 0.01  0 0 1.05 0 0.04  0 0 0 1 0"
            result="cold"
          />
          <Bloom input="cold" std={3} gain={0.15} result="out" />
        </filter>

        {/* SATELLITE — pan-sharpened, muted reconnaissance imagery */}
        <filter id="vf-satellite" {...filterProps}>
          <feConvolveMatrix
            in="SourceGraphic"
            order="3"
            kernelMatrix="0 -0.6 0 -0.6 3.4 -0.6 0 -0.6 0"
            divisor="1"
            preserveAlpha="true"
            result="sharp"
          />
          <feColorMatrix in="sharp" type="saturate" values="0.55" result="muted" />
          <feComponentTransfer in="muted" result="graded">
            <feFuncR type="linear" slope="1.14" intercept="-0.05" />
            <feFuncG type="linear" slope="1.16" intercept="-0.04" />
            <feFuncB type="linear" slope="1.12" intercept="-0.03" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
  );
}
