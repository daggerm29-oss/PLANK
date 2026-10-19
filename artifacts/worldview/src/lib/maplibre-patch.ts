import maplibregl from "maplibre-gl";

/**
 * Monkey-patches MapLibre GL to prevent upstream issue #7752:
 * "Error: Out of bounds. Index requested n=0 can't be >= this._numberToString.length 0"
 * which occurs inside DictionaryCoder.decode / FeatureIndex.lookupSymbolFeatures /
 * queryRenderedSymbols during mousemove / queryRenderedFeatures calls on symbol layers.
 */
let isPatched = false;

export function applyMapLibrePatch(): void {
  if (isPatched || typeof window === "undefined") return;

  const patchQueryRendered = (targetProto: any) => {
    if (!targetProto || typeof targetProto.queryRenderedFeatures !== "function") return;
    const original = targetProto.queryRenderedFeatures;
    targetProto.queryRenderedFeatures = function (...args: any[]) {
      try {
        return original.apply(this, args);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err.message.includes("_numberToString") ||
            err.message.includes("Out of bounds") ||
            err.message.includes("loadMatchingFeature") ||
            err.message.includes("lookupSymbolFeatures"))
        ) {
          // Gracefully suppress known MapLibre out-of-bounds symbol index crash and return empty list
          return [];
        }
        throw err;
      }
    };
  };

  try {
    if ((maplibregl as any)?.Map?.prototype) {
      patchQueryRendered((maplibregl as any).Map.prototype);
    }
    if ((maplibregl as any)?.Style?.prototype) {
      patchQueryRendered((maplibregl as any).Style.prototype);
    }
    isPatched = true;
  } catch (err) {
    console.warn("Failed to apply MapLibre GL patch:", err);
  }
}

// Auto-execute on import
applyMapLibrePatch();
