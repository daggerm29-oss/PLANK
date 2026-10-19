import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip } from "recharts";
import { FloatingPanel } from "./FloatingPanel";
import { type Ship, type ShipFilters, isAisGapCandidate } from "./ShipsLayer";

interface Props {
  ships: Ship[];
  filters: ShipFilters;
  onFiltersChange: (next: ShipFilters) => void;
  loading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  onClose: () => void;
}

interface OilDailyEntry {
  day: string;
  tankers: number;
  barrels: number;
}

interface OilDailyResponse {
  days: OilDailyEntry[];
  avg_barrels_per_day_last_7d: number;
  note?: string;
}

interface OilLiveResponse {
  active_tankers: number;
  total_barrels_in_transit?: number;
  capacity_barrels_in_region: number;
  inbound_tankers: number;
  inbound_barrels_to_india: number;
  arrived_last_24h: {
    tankers: number;
    barrels: number;
  };
  note?: string;
}

// Render colours mirror ShipsLayer for visual consistency between the panel
// chips, the metric blocks, and the dots on the globe.
const C_TANKER = "#ff3b30";
const C_MIL    = "#3a8dff";
const C_AIS    = "#ffffff";
const C_GAP    = "#ff9500";
const C_CYAN   = "#00ffff";

function formatCompactBarrels(val: number): string {
  if (val >= 1_000_000_000) return (val / 1_000_000_000).toFixed(1) + "B";
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(1) + "K";
  return val.toLocaleString();
}

/**
 * MARITIME INTEL — floating data panel with three sections:
 *   1. FILTERS — toggle Military / Tanker / Global AIS / AIS Gap classes on the globe.
 *   2. LIVE METRICS — counts derived from the latest /api/proxy/ships tick.
 *   3. OIL ANALYTICS — India crude arrivals bar chart & regional tanker capacity readouts.
 *
 * Pinned header + scrollable body, matching the Aviation Intel layout so the
 * tactical aesthetic stays consistent across the windowing system.
 */
export function MaritimePanel({
  ships,
  filters,
  onFiltersChange,
  loading,
  error,
  lastUpdate,
  onClose,
}: Props) {
  // Derive live metrics from the unfiltered tick — filters only affect what
  // gets rendered on the globe, not what gets counted in the readout.
  let activeTankers = 0;
  let activeMilitary = 0;
  let activeGlobal = 0;
  let activeGaps = 0;
  for (const s of ships) {
    if (isAisGapCandidate(s)) activeGaps++;
    else if (s.source === "AISSTREAM") activeGlobal++;
    else if (s.category === "TANKER") activeTankers++;
    else if (s.category === "MILITARY") activeMilitary++;
  }

  // Oil analytics state — polled gently every 60s without localStorage
  const [oilLive, setOilLive] = useState<OilLiveResponse | null>(null);
  const [oilDaily, setOilDaily] = useState<OilDailyResponse | null>(null);
  const [oilLoading, setOilLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchOilData() {
      try {
        const [liveRes, dailyRes] = await Promise.allSettled([
          fetch("/api/proxy/oil/live"),
          fetch("/api/proxy/oil/daily"),
        ]);

        if (cancelled) return;

        if (liveRes.status === "fulfilled" && liveRes.value.ok) {
          const liveData = (await liveRes.value.json()) as OilLiveResponse;
          if (!cancelled) setOilLive(liveData);
        }

        if (dailyRes.status === "fulfilled" && dailyRes.value.ok) {
          const dailyData = (await dailyRes.value.json()) as OilDailyResponse;
          if (!cancelled) setOilDaily(dailyData);
        }
      } catch {
        // Retain stale data on network glitch
      } finally {
        if (!cancelled) setOilLoading(false);
      }
    }

    fetchOilData();
    const interval = setInterval(fetchOilData, 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const estimatesTooltip =
    oilLive?.note ||
    oilDaily?.note ||
    "Estimates based on tanker DWT and reported AIS destination. May reflect coverage or latency limits.";

  return (
    <FloatingPanel
      title="MARITIME INTEL"
      initialX={54}
      initialY={420}
      width={320}
      onClose={onClose}
    >
      <div style={{
        height: "100%", display: "flex", flexDirection: "column",
        overflow: "hidden", position: "relative",
      }}>
        {/* scan-line accent — same as Aviation Intel */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 2,
          background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.6),transparent)",
          animation: "scan 4s linear infinite", zIndex: 2,
        }} />

        {/* HEADER (pinned) */}
        <div style={{ padding: "14px 16px 10px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%", background: "#00ffff",
              boxShadow: "0 0 6px rgba(0,255,255,0.8)",
              animation: "pulse-glow 2s ease-in-out infinite",
            }} />
            <span style={{
              fontSize: 13, letterSpacing: "0.35em", color: "#00ffff",
              textShadow: "0 0 8px rgba(0,255,255,0.5)",
              textTransform: "uppercase", fontWeight: 700,
            }}>MARITIME</span>
            <span style={{
              marginLeft: "auto", color: "rgba(0,255,255,0.5)", fontSize: 10,
              animation: "blink-anim 1.2s step-end infinite",
            }}>_</span>
          </div>
          <div style={{
            fontSize: 8, letterSpacing: "0.2em",
            color: "rgba(0,255,255,0.35)", textTransform: "uppercase",
          }}>FUSED RADAR · AISSTREAM · MARINETRAFFIC</div>
        </div>

        <SectionDivider />

        {/* SCROLLABLE BODY */}
        <div className="glow-scroll" style={{
          flex: 1, minHeight: 0, overflowY: "auto",
          display: "flex", flexDirection: "column",
        }}>
          {/* ── FILTERS ────────────────────────────────────────────────── */}
          <Section label="FILTERS">
            <FilterToggle
              label="MILITARY"
              dotColor={C_MIL}
              checked={filters.military}
              onChange={(v) => onFiltersChange({ ...filters, military: v })}
            />
            <FilterToggle
              label="TANKERS"
              dotColor={C_TANKER}
              checked={filters.tankers}
              onChange={(v) => onFiltersChange({ ...filters, tankers: v })}
            />
            <FilterToggle
              label="GLOBAL AIS"
              dotColor={C_AIS}
              checked={filters.globalAis}
              onChange={(v) => onFiltersChange({ ...filters, globalAis: v })}
            />
            <FilterToggle
              label="AIS GAP CANDIDATES"
              dotColor={C_GAP}
              checked={filters.aisGap}
              onChange={(v) => onFiltersChange({ ...filters, aisGap: v })}
              tooltip="Ships that stopped transmitting AIS for 30+ min. May also be a coverage gap."
            />
          </Section>

          <SectionDivider />

          {/* ── LIVE METRICS ───────────────────────────────────────────── */}
          <Section label="LIVE METRICS">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <MetricBlock label="TANKERS"  value={activeTankers}  color={C_TANKER} />
              <MetricBlock label="MILITARY" value={activeMilitary} color={C_MIL} />
              <MetricBlock label="GLOBAL"   value={activeGlobal}   color={C_AIS} />
              <MetricBlock
                label="AIS GAP CANDIDATES"
                value={activeGaps}
                color={C_GAP}
                tooltip="Ships that stopped transmitting AIS for 30+ min. May also be a coverage gap."
              />
            </div>
            {error && (
              <div style={{
                marginTop: 8, padding: "5px 8px",
                background: "rgba(255,50,50,0.07)",
                border: "1px solid rgba(255,50,50,0.2)",
                borderRadius: 2, fontSize: 9,
                color: "rgba(255,100,100,0.7)", letterSpacing: "0.1em",
              }}>⚠ {error}</div>
            )}
          </Section>

          <SectionDivider />

          {/* ── OIL ANALYTICS ─────────────────────────────────────────── */}
          <Section
            label="OIL ANALYTICS"
            headerRight={
              <span
                title={estimatesTooltip}
                style={{
                  fontSize: 8, color: "rgba(0,255,255,0.5)",
                  border: "1px solid rgba(0,255,255,0.3)",
                  borderRadius: "50%", width: 13, height: 13,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  cursor: "help",
                }}
              >
                ℹ
              </span>
            }
          >
            {/* Chart 1: India crude arrivals */}
            <IndiaCrudeArrivalsChart
              daily={oilDaily}
              loading={oilLoading && !oilDaily}
              tooltipText={estimatesTooltip}
            />

            <div style={{ height: 8 }} />

            {/* Stats row from /oil/live: on the way to India & arrived last 24h */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
              <div style={{
                padding: 8,
                background: "rgba(0,255,255,0.03)",
                border: "1px solid rgba(0,255,255,0.12)",
                borderRadius: 2,
              }}>
                <div style={{
                  fontSize: 7, letterSpacing: "0.12em",
                  color: "rgba(0,255,255,0.5)", textTransform: "uppercase",
                  marginBottom: 3,
                }}>
                  ON THE WAY TO INDIA
                </div>
                <div style={{
                  fontSize: 14, fontWeight: 700, color: "#ff3b30",
                  fontFamily: "'Share Tech Mono','Courier New',monospace",
                  lineHeight: 1.1,
                }}>
                  {oilLive ? `${oilLive.inbound_tankers} tankers` : (oilLoading ? "..." : "Collecting data...")}
                </div>
                <div style={{
                  fontSize: 9, color: "rgba(255,59,48,0.75)",
                  fontFamily: "'Share Tech Mono','Courier New',monospace",
                  marginTop: 2,
                }}>
                  {oilLive ? `~${formatCompactBarrels(oilLive.inbound_barrels_to_india)} bbl` : ""}
                </div>
              </div>

              <div style={{
                padding: 8,
                background: "rgba(0,255,255,0.03)",
                border: "1px solid rgba(0,255,255,0.12)",
                borderRadius: 2,
              }}>
                <div style={{
                  fontSize: 7, letterSpacing: "0.12em",
                  color: "rgba(0,255,255,0.5)", textTransform: "uppercase",
                  marginBottom: 3,
                }}>
                  ARRIVED LAST 24H
                </div>
                <div style={{
                  fontSize: 14, fontWeight: 700, color: "#00ffff",
                  fontFamily: "'Share Tech Mono','Courier New',monospace",
                  lineHeight: 1.1,
                }}>
                  {oilLive ? `${oilLive.arrived_last_24h.tankers} tankers` : (oilLoading ? "..." : "Collecting data...")}
                </div>
                <div style={{
                  fontSize: 9, color: "rgba(0,255,255,0.7)",
                  fontFamily: "'Share Tech Mono','Courier New',monospace",
                  marginTop: 2,
                }}>
                  {oilLive ? `~${formatCompactBarrels(oilLive.arrived_last_24h.barrels)} bbl` : ""}
                </div>
              </div>
            </div>

            {/* Regional Tanker Capacity banner: Strictly labelled "Tanker capacity in region (not imports)" */}
            <div style={{
              padding: "7px 9px",
              background: "rgba(0,255,255,0.02)",
              border: "1px solid rgba(0,255,255,0.1)",
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}>
              <div>
                <div style={{
                  fontSize: 7, letterSpacing: "0.12em",
                  color: "rgba(0,255,255,0.5)", textTransform: "uppercase",
                }}>
                  Tanker capacity in region (not imports)
                </div>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,0.85)",
                  fontFamily: "'Share Tech Mono','Courier New',monospace",
                  marginTop: 2,
                }}>
                  {oilLive ? (
                    <span>
                      {oilLive.active_tankers} tankers · ~{formatCompactBarrels(oilLive.capacity_barrels_in_region)} bbl
                    </span>
                  ) : (
                    <span style={{ fontSize: 9, color: "rgba(0,255,255,0.35)" }}>
                      {oilLoading ? "Loading..." : "Collecting data..."}
                    </span>
                  )}
                </div>
              </div>
              <span
                title={estimatesTooltip}
                style={{
                  fontSize: 8, color: "rgba(0,255,255,0.4)",
                  cursor: "help",
                }}
              >
                ℹ
              </span>
            </div>
          </Section>
        </div>

        {/* FOOTER (pinned) */}
        <div style={{
          height: 1, margin: "0 16px",
          background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.2),transparent)",
        }} />
        <div style={{
          padding: "6px 16px", flexShrink: 0,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ fontSize: 8, color: "rgba(0,255,255,0.3)", letterSpacing: "0.08em" }}>
            {lastUpdate ? `UPD ${lastUpdate.toLocaleTimeString()}` : "INIT"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {loading && (
              <div style={{
                width: 5, height: 5, borderRadius: "50%",
                background: "rgba(0,255,255,0.8)",
                boxShadow: "0 0 4px rgba(0,255,255,0.8)",
                animation: "pulse-glow 2s ease-in-out infinite",
              }} />
            )}
            <div style={{ fontSize: 8, color: "rgba(0,255,255,0.3)", letterSpacing: "0.1em" }}>
              RADAR LIVE · 5s · OIL 60s
            </div>
          </div>
        </div>
      </div>
    </FloatingPanel>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SectionDivider() {
  return (
    <div style={{
      height: 1, margin: "0 16px",
      background: "linear-gradient(90deg,transparent,rgba(0,255,255,0.18),transparent)",
    }} />
  );
}

function Section({
  label,
  children,
  headerRight,
}: {
  label: string;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
}) {
  return (
    <div style={{ padding: "10px 16px 12px" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 8,
      }}>
        <div style={{
          fontSize: 8, letterSpacing: "0.2em",
          color: "rgba(0,255,255,0.35)", textTransform: "uppercase",
        }}>{label}</div>
        {headerRight}
      </div>
      {children}
    </div>
  );
}

function FilterToggle({
  label, dotColor, checked, onChange, tooltip,
}: { label: string; dotColor: string; checked: boolean; onChange: (v: boolean) => void; tooltip?: string }) {
  return (
    <button
      type="button"
      title={tooltip}
      onClick={() => onChange(!checked)}
      style={{
        width: "100%", padding: "7px 10px", marginBottom: 4,
        background: checked ? "rgba(0,255,255,0.06)" : "rgba(0,255,255,0.015)",
        border: `1px solid ${checked ? "rgba(0,255,255,0.45)" : "rgba(0,255,255,0.12)"}`,
        borderRadius: 2, cursor: "pointer",
        display: "flex", alignItems: "center", gap: 9,
        fontFamily: "'Share Tech Mono','Courier New',monospace",
        transition: "all 0.12s ease",
      }}
      onMouseEnter={(e) => {
        if (!checked) e.currentTarget.style.background = "rgba(0,255,255,0.05)";
      }}
      onMouseLeave={(e) => {
        if (!checked) e.currentTarget.style.background = "rgba(0,255,255,0.015)";
      }}
    >
      {/* Custom checkbox box — matches the tactical aesthetic */}
      <span style={{
        width: 12, height: 12, flexShrink: 0,
        border: `1px solid ${checked ? "rgba(0,255,255,0.7)" : "rgba(0,255,255,0.3)"}`,
        background: checked ? "rgba(0,255,255,0.18)" : "transparent",
        borderRadius: 1,
        boxShadow: checked ? "0 0 6px rgba(0,255,255,0.5), inset 0 0 4px rgba(0,255,255,0.3)" : "none",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, color: "#00ffff", lineHeight: 1,
      }}>
        {checked ? "✓" : ""}
      </span>
      {/* Color dot for the class */}
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: dotColor,
        boxShadow: `0 0 5px ${dotColor}`,
      }} />
      <span style={{
        fontSize: 10, letterSpacing: "0.18em",
        color: checked ? "#00ffff" : "rgba(0,255,255,0.55)",
        textTransform: "uppercase",
        display: "inline-flex", alignItems: "center", gap: 5, flex: 1, justifyContent: "space-between",
      }}>
        <span>{label}</span>
        {tooltip && (
          <span
            title={tooltip}
            style={{
              fontSize: 8, color: "rgba(0,255,255,0.5)", border: "1px solid rgba(0,255,255,0.3)",
              borderRadius: "50%", width: 12, height: 12, display: "inline-flex",
              alignItems: "center", justifyContent: "center", letterSpacing: 0,
            }}
          >
            ?
          </span>
        )}
      </span>
    </button>
  );
}

function MetricBlock({ label, value, color, tooltip }: { label: string; value: number; color: string; tooltip?: string }) {
  return (
    <div
      title={tooltip}
      style={{
        padding: 8,
        background: "rgba(0,255,255,0.03)",
        border: "1px solid rgba(0,255,255,0.1)",
        borderRadius: 2,
        cursor: tooltip ? "help" : "default",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 5, marginBottom: 4,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: color, boxShadow: `0 0 4px ${color}`,
        }} />
        <span style={{
          fontSize: 7, letterSpacing: "0.12em",
          color: "rgba(0,255,255,0.45)", textTransform: "uppercase",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{label}</span>
        {tooltip && (
          <span style={{ fontSize: 7, color: "rgba(0,255,255,0.4)", marginLeft: "auto" }}>ℹ</span>
        )}
      </div>
      <div style={{
        color, fontSize: 16, fontWeight: 700, lineHeight: 1,
        fontFamily: "'Share Tech Mono','Courier New',monospace",
        textShadow: `0 0 6px ${color}55`,
      }}>{value.toLocaleString()}</div>
    </div>
  );
}

/**
 * India crude arrivals (est. barrels/day)
 * Bar chart of the days array from /oil/daily (x = day, y = barrels)
 * Big number above showing avg_barrels_per_day_last_7d
 */
function IndiaCrudeArrivalsChart({
  daily,
  loading,
  tooltipText,
}: {
  daily: OilDailyResponse | null;
  loading: boolean;
  tooltipText?: string;
}) {
  const days = daily?.days ?? [];
  const hasHistory = days.some((d) => (d.barrels || 0) > 0 || (d.tankers || 0) > 0);

  // Format chart data: short date MM/DD
  const chartData = days.map((d) => {
    const parts = d.day.split("-");
    const shortLabel = parts.length === 3 ? `${parts[1]}/${parts[2]}` : d.day;
    return {
      day: shortLabel,
      fullDay: d.day,
      barrels: d.barrels,
      tankers: d.tankers,
    };
  });

  return (
    <div style={{
      padding: "8px 8px 6px",
      background: "rgba(0,255,255,0.03)",
      border: "1px solid rgba(0,255,255,0.12)",
      borderRadius: 2,
      position: "relative",
    }}>
      {/* Header with Title and 7-day Average */}
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        marginBottom: 6,
      }}>
        <div>
          <div style={{
            fontSize: 8, letterSpacing: "0.18em",
            color: "rgba(0,255,255,0.75)", textTransform: "uppercase",
            fontWeight: 700,
          }}>
            India crude arrivals
          </div>
          <div style={{
            fontSize: 7, letterSpacing: "0.1em",
            color: "rgba(0,255,255,0.35)", textTransform: "uppercase",
            marginTop: 1,
          }}>
            est. barrels / day
          </div>
        </div>

        {/* Big number: 7-day average */}
        <div style={{ textAlign: "right" }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: "#00ffff",
            fontFamily: "'Share Tech Mono','Courier New',monospace",
            lineHeight: 1,
            textShadow: "0 0 6px rgba(0,255,255,0.4)",
          }}>
            {daily ? (
              daily.avg_barrels_per_day_last_7d > 0
                ? `${formatCompactBarrels(daily.avg_barrels_per_day_last_7d)}/d`
                : "0 bbl/d"
            ) : (
              "—"
            )}
          </div>
          <div style={{
            fontSize: 6.5, letterSpacing: "0.1em",
            color: "rgba(0,255,255,0.4)", textTransform: "uppercase",
            marginTop: 2,
          }}>
            7D AVG
          </div>
        </div>
      </div>

      {/* Chart Canvas */}
      <div style={{ width: "100%", height: 105, position: "relative" }}>
        {hasHistory ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <CartesianGrid stroke="rgba(0,255,255,0.08)" strokeDasharray="2 3" vertical={false} />
              <XAxis
                dataKey="day"
                stroke="rgba(0,255,255,0.3)"
                tick={{ fontSize: 7, fill: "rgba(0,255,255,0.5)" }}
                tickLine={false}
                axisLine={{ stroke: "rgba(0,255,255,0.2)" }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="rgba(0,255,255,0.3)"
                tick={{ fontSize: 7, fill: "rgba(0,255,255,0.4)" }}
                tickLine={false}
                axisLine={{ stroke: "rgba(0,255,255,0.2)" }}
                tickFormatter={(v: number) => formatCompactBarrels(v)}
                width={30}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload as { fullDay: string; barrels: number; tankers: number };
                    return (
                      <div style={{
                        background: "rgba(2,6,12,0.92)",
                        border: "1px solid rgba(0,255,255,0.4)",
                        padding: "4px 7px",
                        fontSize: 9,
                        fontFamily: "'Share Tech Mono','Courier New',monospace",
                        color: "#00ffff",
                        boxShadow: "0 0 8px rgba(0,255,255,0.2)",
                      }}>
                        <div style={{ color: "rgba(0,255,255,0.6)", fontSize: 8 }}>{data.fullDay}</div>
                        <div>{data.barrels.toLocaleString()} bbl</div>
                        <div style={{ color: "#ff3b30", fontSize: 8 }}>{data.tankers} tankers</div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Bar
                dataKey="barrels"
                fill="#00ffff"
                opacity={0.85}
                radius={[1, 1, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            border: "1px dashed rgba(0,255,255,0.12)",
            borderRadius: 2,
          }}>
            <span style={{
              fontSize: 8, letterSpacing: "0.2em",
              color: "rgba(0,255,255,0.45)", textTransform: "uppercase",
              background: "rgba(2,4,8,0.55)", padding: "2px 6px", borderRadius: 1,
            }}>
              {loading ? "FETCHING TELEMETRY..." : "Collecting data..."}
            </span>
            <span style={{
              fontSize: 7, color: "rgba(0,255,255,0.25)", marginTop: 4,
            }}>
              Few days of history recorded
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

