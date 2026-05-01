import { useState, useEffect, useCallback, useRef, Component } from "react";
import _ReactPlotly from "react-plotly.js";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
// react-plotly.js is Babel CJS (exports.default = ...). Rolldown may hand us the
// whole exports object rather than unwrapping .default — handle both cases.
const Plot = typeof _ReactPlotly === "function" ? _ReactPlotly : _ReactPlotly.default;
import "./App.css";

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(err) { return { error: err }; }
  componentDidCatch(err, info) { console.error("[ErrorBoundary]", err, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh", background: "#0a0a0a", color: "#fff",
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 12, padding: 32, fontFamily: "system-ui"
        }}>
          <div style={{ fontSize: 28 }}>⚠</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>UI Error</div>
          <div style={{ fontSize: 12, color: "#f87171", maxWidth: 600, textAlign: "center" }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 12, padding: "8px 20px", background: "#2563eb", color: "#fff",
              border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 700 }}
          >Dismiss</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const API = "http://100.113.84.82:8000";

function fmtDuration(ms) {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000)      return `${ms} ms`;
  if (ms < 60000)     return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 3600000)   return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

const SAMPLE_RATE_LABEL = "1.5625 MS/s"; // fixed logger rate: 1,562,500 Hz

function hexToText(hexStr) {
  if (!hexStr) return "—";
  return hexStr.split(" ").map(h => {
    const code = parseInt(h, 16);
    return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ".";
  }).join("");
}

const WINDOW_MS = 10; // default display window in ms
const MIN_WINDOW_S = 0.002; // 2 ms — minimum zoom window

// For each pair of adjacent samples more than GAP_THRESH_S apart:
//   - insert a null break in the main trace (no false blue/orange bridge)
//   - collect the two endpoint pairs so a separate green trace can draw the bridge
const GAP_THRESH_S = 0.002; // 2 ms — slightly more than one 1 ms chunk
function processTrace(times, samples) {
  if (!times || times.length === 0) return { x: [], y: [], gaps: [] };
  const x = [], y = [], gaps = [];
  for (let i = 0; i < times.length; i++) {
    if (i > 0 && times[i] - times[i - 1] > GAP_THRESH_S) {
      gaps.push([times[i - 1], samples[i - 1], times[i], samples[i]]);
      x.push((times[i - 1] + times[i]) / 2); // null break at mid-point
      y.push(null);
    }
    x.push(times[i]);
    y.push(samples[i]);
  }
  return { x, y, gaps };
}

function fmtLocalTime(unixS) {
  const d = new Date(unixS * 1000);
  const pad  = n => String(n).padStart(2, "0");
  const pad3 = n => String(n).padStart(3, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function toDatetimeLocal(d) {
  const pad  = n => String(n).padStart(2, "0");
  const pad3 = n => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

export default function App() {
  const [busId,   setBusId]   = useState(1);
  const [start,   setStart]   = useState("");
  const [dataH,   setDataH]   = useState(null);
  const [dataL,   setDataL]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [buses,   setBuses]   = useState([]);
  const [apiOk,   setApiOk]   = useState(null);
  const [frames,      setFrames]      = useState(null);
  const [decoding,    setDecoding]    = useState(false);
  const [decodeError, setDecodeError] = useState("");
  const [findingEdge, setFindingEdge] = useState(null); // null | "prev" | "next"
  const [viewRange,   setViewRange]   = useState(null); // [unixS_start, unixS_end] | null
  // Cursor measure tool: two timestamps placed by clicking the chart
  const [measureMode,    setMeasureMode]    = useState(false);
  const [cursors,        setCursors]        = useState([]); // up to 2 unix timestamps
  const [storage,        setStorage]        = useState(null); // /storage response
  const [showBitLines,   setShowBitLines]   = useState(true);  // toggle red bit-boundary lines
  const [plotRevision,   setPlotRevision]   = useState(0);     // bump to force Plotly re-render
  // Incremented only on EXPLICIT navigation (time picker, navigate, findEdge, fetch button).
  // Plotly's uirevision: when this is unchanged, Plotly ignores xaxis.range prop updates
  // (no zoom-reset on pan/re-render).  When it changes, Plotly accepts the new range.
  const [uiRevision,     setUiRevision]     = useState(1);

  // Startup: health check + active buses
  useEffect(() => {
    fetch(`${API}/health`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(() => setApiOk(true))
      .catch(() => setApiOk(false));

    fetch(`${API}/buses`)
      .then(r => r.json())
      .then(setBuses)
      .catch(() => {});
  }, []);

  // Storage stats — fetch once on mount, then every 10 minutes
  useEffect(() => {
    const fetchStorage = () =>
      fetch(`${API}/storage`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(setStorage)
        .catch(() => {});
    fetchStorage();
    const id = setInterval(fetchStorage, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const fetchAt = useCallback(async (startStr, durationMs = WINDOW_MS) => {
    if (!startStr) { setError("Select a start time."); return; }
    const visT0 = new Date(startStr);

    // Fetch 3× the visible window (1× pre-pad, 1× vis, 1× post-pad) so that
    // normal pan/zoom stays within the loaded buffer and avoids re-fetching.
    // Cap padding at 50 ms to keep API response times fast on wide views.
    const padMs = Math.min(durationMs, 50);
    const t0 = new Date(visT0.getTime() - padMs);
    const t1 = new Date(visT0.getTime() + durationMs + padMs);

    // Cancel any previous in-flight request
    if (abortRef.current) { abortRef.current.abort(); }
    const controller = new AbortController();
    abortRef.current = controller;

    // Clear error/frames but keep old dataH/dataL visible during load
    setError(""); setLoading(true); setFrames(null); setDecodeError("");
    try {
      const mkParams = ch => new URLSearchParams({
        bus_id: busId, channel: ch,
        start: t0.toISOString(), end: t1.toISOString(),
        max_points: 8000,
      });
      const [resH, resL] = await Promise.all([
        fetch(`${API}/query?${mkParams("H")}`, { signal: controller.signal }),
        fetch(`${API}/query?${mkParams("L")}`, { signal: controller.signal }),
      ]);
      if (!resH.ok) { const b = await resH.json().catch(() => ({})); throw new Error("CAN-H: " + (b.detail ?? `HTTP ${resH.status}`)); }
      if (!resL.ok) { const b = await resL.json().catch(() => ({})); throw new Error("CAN-L: " + (b.detail ?? `HTTP ${resL.status}`)); }
      const [dH, dL] = await Promise.all([resH.json(), resL.json()]);
      setDataH(dH);
      setDataL(dL);
      setPlotRevision(v => v + 1);
      // Record the full padded loaded range so zoom/pan checks use the right bounds.
      loadedRangeRef.current = [t0.getTime() / 1000, t1.getTime() / 1000];
      // If fetch returned empty, invalidate loadedRange so the next pan event
      // will re-trigger a fetch rather than silently skipping it.
      const gotData = (dH.times?.length ?? 0) > 0 || (dL.times?.length ?? 0) > 0;
      if (!gotData) loadedRangeRef.current = null;
    } catch (e) {
      if (e.name === "AbortError") return; // superseded by newer fetch — discard
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [busId]);

  // helper: update both start input and the view range atomically
  const applyStart = useCallback((newStart, windowMs = WINDOW_MS) => {
    setStart(newStart);
    const t = new Date(newStart).getTime() / 1000;
    setViewRange([t, t + windowMs / 1000]);
    // Explicit navigation — tell Plotly to accept the incoming xaxis.range
    setUiRevision(v => v + 1);
  }, []);

  // Always fetch the currently visible viewport.
  // IMPORTANT: use viewRange[0] as the start, NOT the `start` state variable.
  // When the user zooms in within the loaded buffer, handleRelayout skips setStart
  // (because no fetch is needed), leaving `start` pointing at the original unzoomed
  // position. Clicking refresh with that stale start fetches data from the wrong
  // time and the viewport comes up blank.
  const fetchWaveform = useCallback(() => {
    const r0 = viewRange ? viewRange[0] : (start ? new Date(start).getTime() / 1000 : null);
    let   r1 = viewRange ? viewRange[1] : (start ? new Date(start).getTime() / 1000 + WINDOW_MS / 1000 : null);
    if (r0 == null) { setError("Select a start time."); return; }
    // If zoomed in tighter than the minimum, expand to MIN_WINDOW_S before fetching
    let effectiveR0 = r0;
    let effectiveR1 = r1;
    if (r1 - r0 < MIN_WINDOW_S) {
      const mid = (r0 + r1) / 2;
      effectiveR0 = mid - MIN_WINDOW_S / 2;
      effectiveR1 = mid + MIN_WINDOW_S / 2;
      setViewRange([effectiveR0, effectiveR1]);
      setUiRevision(v => v + 1);
    }
    const windowMs = (effectiveR1 - effectiveR0) * 1000;
    const actualStart = toDatetimeLocal(new Date(effectiveR0 * 1000));
    // Sync start picker to current view so the UI is consistent
    setStart(actualStart);
    setUiRevision(v => v + 1);
    fetchAt(actualStart, windowMs);
  }, [fetchAt, start, viewRange]);

  // Step forward/back by one current window width
  const navigate = useCallback((dir) => {
    if (!start) return;
    const windowMs = viewRange ? (viewRange[1] - viewRange[0]) * 1000 : WINDOW_MS;
    const newStart = toDatetimeLocal(new Date(new Date(start).getTime() + dir * windowMs));
    applyStart(newStart, windowMs);
    fetchAt(newStart, windowMs);
  }, [start, viewRange, fetchAt, applyStart]);

  // Fired by Plotly continuously while panning.
  // viewRange updates on every event so the axis tracks the drag smoothly.
  // The actual DB fetch is debounced — only fires 150 ms after the last event
  // (i.e. after mouse-up), so we always fetch the final released position.
  const panDebounceRef   = useRef(null);
  const abortRef         = useRef(null);  // AbortController for in-flight fetch
  const loadedRangeRef   = useRef(null);  // [t_start_unix, t_end_unix] of data in dataH/dataL
  const plotDivRef       = useRef(null);  // DOM ref to the Plotly div for image export
  const everHadDataRef   = useRef(false); // true after first non-empty load — Plot never unmounts after this
  const prevWindowRef    = useRef(null);  // last window width in seconds — used to detect zoom vs pan
  const handleRelayout = useCallback((ev) => {
    // Plotly sends either xaxis.range[0]/[1] (pan/scroll) or xaxis.range array (box zoom)
    let r0 = ev["xaxis.range[0]"];
    let r1 = ev["xaxis.range[1]"];
    if ((r0 == null || r1 == null) && Array.isArray(ev["xaxis.range"])) {
      [r0, r1] = ev["xaxis.range"];
    }
    if (r0 == null || r1 == null || ev["xaxis.autorange"]) return;

    // Enforce minimum window: if the user zoomed in past 2 ms, expand symmetrically
    let win = r1 - r0;
    if (win < MIN_WINDOW_S) {
      const mid = (r0 + r1) / 2;
      r0 = mid - MIN_WINDOW_S / 2;
      r1 = mid + MIN_WINDOW_S / 2;
      win = MIN_WINDOW_S;
    }

    setViewRange([r0, r1]);                         // lock axis immediately on every event

    const newWidth = win;
    const prevWidth = prevWindowRef.current;
    // A zoom is any interaction where the window width changed by more than 1%
    const isZoom = prevWidth !== null && Math.abs(newWidth - prevWidth) / prevWidth > 0.01;
    prevWindowRef.current = newWidth;

    const lr = loadedRangeRef.current;
    // Pan within already-loaded range: no fetch needed, just redraw existing data
    if (!isZoom && lr && r0 >= lr[0] && r1 <= lr[1]) return;

    // Zoom (any width change) or pan outside loaded range — debounce then re-fetch.
    if (panDebounceRef.current) clearTimeout(panDebounceRef.current);
    panDebounceRef.current = setTimeout(() => {
      panDebounceRef.current = null;
      const win = r1 - r0;
      const pad = Math.min(win, 0.05);
      loadedRangeRef.current = [r0 - pad, r1 + pad];
      const newStart = toDatetimeLocal(new Date(r0 * 1000));
      const durationMs = win * 1000;
      setStart(newStart);
      fetchAt(newStart, durationMs);
    }, 200);
  }, [fetchAt]);

  const findEdge = useCallback(async (direction) => {
    if (!start) return;
    setFindingEdge(direction); setError("");
    try {
      const params = new URLSearchParams({
        bus_id: busId,
        ref: new Date(start).toISOString(),
        direction,
      });
      const res = await fetch(`${API}/find_edge?${params}`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.detail ?? `HTTP ${res.status}`); }
      const { time_unix } = await res.json();
      const newStart = toDatetimeLocal(new Date(time_unix * 1000));
      applyStart(newStart);
      fetchAt(newStart);
    } catch (e) {
      setError(e.message);
    } finally {
      setFindingEdge(null);
    }
  }, [busId, start, fetchAt, applyStart]);

  const decodeFrames = useCallback(async () => {
    if (!start) return;
    setDecodeError(""); setDecoding(true);
    try {
      // Decode the currently visible window, not just a fixed 10 ms slice
      const winStart = viewRange ? new Date(viewRange[0] * 1000) : new Date(start);
      const winEnd   = viewRange
        ? new Date(viewRange[1] * 1000)
        : new Date(new Date(start).getTime() + WINDOW_MS);
      const params = new URLSearchParams({
        bus_id: busId,
        start: winStart.toISOString(),
        end:   winEnd.toISOString(),
      });
      const res = await fetch(`${API}/decode?${params}`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.detail ?? `HTTP ${res.status}`); }
      setFrames(await res.json());
    } catch (e) {
      setDecodeError(e.message);
    } finally {
      setDecoding(false);
    }
  }, [busId, start, viewRange]);

  // Place/clear measure cursors on chart click
  const handlePlotClick = useCallback((ev) => {
    if (!measureMode) return;
    const pt = ev.points?.[0];
    if (!pt) return;
    const t = pt.x; // unix seconds (linear axis)
    setCursors(prev => {
      if (prev.length >= 2) return [t];  // reset to first cursor
      return [...prev, t];
    });
  }, [measureMode]);

  // ── PDF Snapshot ──────────────────────────────────────────────────────────
  const downloadPDF = useCallback(async () => {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    const margin = 14;
    let y = margin;

    const addText = (text, opts = {}) => {
      const { size = 10, bold = false, color = [220, 220, 220] } = opts;
      doc.setFontSize(size);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setTextColor(...color);
      doc.text(text, margin, y);
      y += size * 0.45;
    };
    const gap = (mm = 4) => { y += mm; };
    const rule = () => {
      doc.setDrawColor(50, 50, 50);
      doc.line(margin, y, W - margin, y);
      y += 3;
    };

    // Dark background
    doc.setFillColor(10, 10, 10);
    doc.rect(0, 0, W, doc.internal.pageSize.getHeight(), "F");

    // Header
    doc.setFillColor(20, 20, 20);
    doc.rect(0, 0, W, 22, "F");
    doc.setFontSize(16); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text("CANlogger Waveform Snapshot", margin, 14);
    doc.setFontSize(9); doc.setFont("helvetica", "normal"); doc.setTextColor(140, 140, 140);
    doc.text(`Generated: ${new Date().toISOString().replace("T"," ").slice(0,19)} UTC`, W - margin, 14, { align: "right" });
    y = 28;

    // Capture specs
    addText("CAPTURE SPECS", { size: 8, bold: true, color: [80, 130, 255] });
    gap(2);
    const specLines = [
      `Bus: ${busId}`,
      `Sample rate: 1,562,500 Hz  (1.5625 MS/s)`,
      `Baud rate: ${frames ? Math.round(frames.bit_rate_hz / 1000) : 125} kbps`,
      `Samples per bit: ${frames ? frames.samples_per_bit : 12.5}`,
      ...(viewRange
        ? [`Window: ${fmtLocalTime(viewRange[0])} → ${fmtLocalTime(viewRange[1])}  (${((viewRange[1]-viewRange[0])*1000).toFixed(2)} ms)`]
        : start ? [`Window start: ${fmtLocalTime(new Date(start).getTime()/1000)}`] : []),
      ...(frames ? [`Decoded: ${frames.frame_count} frame${frames.frame_count !== 1 ? "s" : ""},  ${frames.total_bits} bits`] : []),
    ];
    specLines.forEach(l => { addText(l, { size: 9, color: [180, 180, 180] }); gap(1.5); });
    gap(2); rule();

    // Cursor measurements
    if (cursors.length > 0) {
      addText("CURSOR MEASUREMENTS", { size: 8, bold: true, color: [80, 130, 255] });
      gap(2);
      cursors.forEach((t, i) => {
        addText(`Cursor ${i + 1}: ${fmtLocalTime(t)}  (unix ${t.toFixed(6)})`, { size: 9, color: [250, 204, 21] });
        gap(1.5);
      });
      if (cursors.length === 2) {
        const deltaUs = Math.abs(cursors[1] - cursors[0]) * 1e6;
        const deltaStr = deltaUs < 1000 ? `${deltaUs.toFixed(2)} µs`
          : deltaUs < 1e6 ? `${(deltaUs/1000).toFixed(3)} ms`
          : `${(deltaUs/1e6).toFixed(6)} s`;
        addText(`Δt = ${deltaStr}`, { size: 11, bold: true, color: [250, 204, 21] });
        gap(1.5);
      }
      gap(2); rule();
    }

    // Waveform chart image
    addText("WAVEFORM", { size: 8, bold: true, color: [80, 130, 255] });
    gap(3);
    try {
      const plotDiv = plotDivRef.current?.querySelector(".js-plotly-plot");
      if (plotDiv && window.Plotly) {
        const imgData = await window.Plotly.toImage(plotDiv, {
          format: "png", width: 1400, height: 420, scale: 2,
        });
        const imgW = W - margin * 2;
        const imgH = imgW * (420 / 1400);
        doc.addImage(imgData, "PNG", margin, y, imgW, imgH);
        y += imgH + 4;
      } else {
        addText("[Waveform chart not available]", { size: 9, color: [100, 100, 100] });
        gap(4);
      }
    } catch (e) {
      addText("[Chart export failed]", { size: 9, color: [200, 80, 80] });
      gap(4);
    }
    rule();

    // Frames table
    if (frames?.frames?.length > 0) {
      addText("DECODED CAN FRAMES", { size: 8, bold: true, color: [80, 130, 255] });
      gap(3);
      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Time (UTC)", "CAN ID", "DLC", "Data (hex)", "ASCII"]],
        body: frames.frames.map(f => [
          f.time_utc.replace("T", " ").replace("+00:00", ""),
          f.can_id_hex,
          f.dlc,
          f.data_hex || "—",
          hexToText(f.data_hex),
        ]),
        theme: "grid",
        styles: {
          fontSize: 8,
          cellPadding: 2,
          font: "courier",
          textColor: [220, 220, 220],
          fillColor: [18, 18, 18],
          lineColor: [40, 40, 40],
          lineWidth: 0.2,
        },
        headStyles: {
          fillColor: [30, 50, 100],
          textColor: [180, 210, 255],
          fontStyle: "bold",
          fontSize: 7.5,
        },
        alternateRowStyles: { fillColor: [14, 14, 14] },
        didParseCell: (data) => {
          // Highlight bad-CRC rows in red
          const rowIdx = data.row.index;
          if (frames.frames[rowIdx] && !frames.frames[rowIdx].crc_ok) {
            data.cell.styles.textColor = [239, 100, 100];
          }
        },
      });
      y = doc.lastAutoTable.finalY + 4;
    }

    const filename = `can_snapshot_bus${busId}_${new Date().toISOString().slice(0,19).replace(/[T:]/g,"-")}.pdf`;
    doc.save(filename);
  }, [busId, frames, cursors, viewRange, start]);

  const downloadCSV = useCallback((ch) => {
    // Fetch full-resolution data from the /export endpoint (no downsampling).
    // Uses the current visible viewRange as the export window.
    if (!viewRange) return;
    const t0 = new Date(viewRange[0] * 1000).toISOString();
    const t1 = new Date(viewRange[1] * 1000).toISOString();
    const params = new URLSearchParams({ bus_id: busId, channel: ch, start: t0, end: t1 });
    const a = document.createElement("a");
    a.href = `${API}/export?${params}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  }, [viewRange, busId]);

  // Allow Enter key to trigger fetch
  useEffect(() => {
    const handler = e => { if (e.key === "Enter") fetchWaveform(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fetchWaveform]);

  const durationMs   = start ? WINDOW_MS : 0;
  const sampleCountH = dataH?.displayed_samples ?? dataH?.times?.length ?? 0;
  const sampleCountL = dataL?.displayed_samples ?? dataL?.times?.length ?? 0;
  const hasData      = sampleCountH > 0 || sampleCountL > 0;
  // Once the chart has ever been populated, keep the Plot div mounted permanently.
  // This prevents the flash-to-blank caused by a fetch returning zero rows (race on
  // fast scroll/zoom) from unmounting and remounting the Plotly canvas.
  if (hasData) everHadDataRef.current = true;
  const showChart = everHadDataRef.current;

  // 3 evenly-spaced local-time tick labels spanning the current 1 ms window
  const _tr = viewRange ?? (start
    ? [new Date(start).getTime() / 1000, new Date(start).getTime() / 1000 + WINDOW_MS / 1000]
    : null);
  const xTickProps = _tr ? {
    tickmode: "array",
    tickvals: [_tr[0], (_tr[0] + _tr[1]) / 2, _tr[1]],
    ticktext: [fmtLocalTime(_tr[0]), fmtLocalTime((_tr[0] + _tr[1]) / 2), fmtLocalTime(_tr[1])],
  } : { tickmode: "auto" };

  // Vertical red lines at each bit boundary — filtered to visible range to keep Plotly fast
  const bitBoundaryShapes = (() => {
    if (!showBitLines) return [];
    const annots = frames?.bit_annotations;
    if (!annots?.length || !frames?.bit_rate_hz) return [];
    const halfBit = 1 / (2 * frames.bit_rate_hz);
    // Only render lines inside the current view + 15% buffer — avoids thousands of off-screen shapes
    const vr = viewRange;
    const visible = vr
      ? annots.filter(a => {
          const x = a.time_unix - halfBit;
          const buf = (vr[1] - vr[0]) * 0.15;
          return x >= vr[0] - buf && x <= vr[1] + buf;
        })
      : annots;
    const cap = Math.min(visible.length, 800);
    return Array.from({ length: cap }, (_, i) => ({
      type: "line",
      x0: visible[i].time_unix - halfBit,
      x1: visible[i].time_unix - halfBit,
      yref: "paper", y0: 0, y1: 1,
      line: { color: "rgba(239,68,68,0.55)", width: 0.8 },
      layer: "above",
    }));
  })();

  // All shapes: bit boundaries + frame start lines + measure cursors
  const frameShapes = [
    ...bitBoundaryShapes,
    ...(frames?.frames ?? []).map(f => ({
      type: "line",
      x0: f.time_unix, x1: f.time_unix,
      yref: "paper", y0: 0, y1: 1,
      line: { color: f.crc_ok ? "rgba(34,212,122,0.55)" : "rgba(239,68,68,0.55)", width: 1 },
    })),
    ...cursors.map((t, idx) => ({
      type: "line",
      x0: t, x1: t,
      yref: "paper", y0: 0, y1: 1,
      line: { color: idx === 0 ? "rgba(250,204,21,0.9)" : "rgba(251,146,60,0.9)", width: 1.5, dash: "dash" },
    })),
    ...(cursors.length === 2 ? [{
      type: "rect",
      x0: cursors[0], x1: cursors[1],
      yref: "paper", y0: 0, y1: 1,
      fillcolor: "rgba(250,204,21,0.06)",
      line: { width: 0 },
      layer: "below",
    }] : []),
  ];

  // Measure readout helpers
  const measureDeltaUs = cursors.length === 2
    ? Math.abs(cursors[1] - cursors[0]) * 1e6
    : null;
  const fmtMeasure = (us) => {
    if (us === null) return null;
    if (us < 1000)    return `${us.toFixed(2)} µs`;
    if (us < 1000000) return `${(us / 1000).toFixed(3)} ms`;
    return `${(us / 1e6).toFixed(6)} s`;
  };

  return (
    <ErrorBoundary>
    <div className="app">

      {/* ── Header ─────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <div className="logo-mark">CAN</div>
          <div>
            <h1 className="header-title">Waveform Logger</h1>
            <span className="header-sub">Geekom A6 · TimescaleDB · 24 hr buffer</span>
          </div>
        </div>
        <div className="header-right">
          {storage && (
            <div className="storage-widget">
              <div className="storage-bar-wrap" title={`Disk: ${storage.disk_used_gb} GB used of ${storage.disk_total_gb} GB`}>
                <div className="storage-bar-fill" style={{
                  width: `${storage.disk_used_pct}%`,
                  background: storage.disk_used_pct > 90 ? "#ef4444"
                            : storage.disk_used_pct > 75 ? "#f59e0b"
                            : "#2563eb",
                }} />
              </div>
              <div className="storage-labels">
                <span className={`storage-disk ${
                  storage.disk_used_pct > 90 ? "storage-crit"
                  : storage.disk_used_pct > 75 ? "storage-warn" : ""
                }`}>{storage.disk_free_gb} GB free</span>
              </div>
            </div>
          )}
          <div className="status-pill">
            <span className={`status-dot ${apiOk === true ? "ok" : apiOk === false ? "err" : "pending"}`} />
            <span className="status-text">
              {apiOk === true ? "API ONLINE" : apiOk === false ? "API OFFLINE" : "CONNECTING"}
            </span>
          </div>
        </div>
      </header>

      {/* ── Control Panel ──────────────────────────── */}
      <section className="control-panel">

        <div className="ctrl-group">
          <span className="ctrl-label">CAN Bus</span>
          <div className="seg">
            {[1,2,3,4,5].map(n => (
              <button
                key={n}
                className={`seg-btn${busId === n ? " seg-active" : ""}`}
                onClick={() => setBusId(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">Start Time (local) · 1 ms window</span>
          <input
            className="time-input"
            type="datetime-local"
            step="0.001"
            value={start}
            onChange={e => applyStart(e.target.value)}
          />
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">Navigate</span>
          <div className="nav-btns">
            <button
              className="nav-btn nav-btn-edge"
              onClick={() => findEdge("prev")}
              disabled={loading || findingEdge !== null || !start}
              title="Prev rising edge (CAN-H > 3.3 V)"
            >{findingEdge === "prev" ? <span className="spinner" style={{width:9,height:9,borderWidth:2}}/> : "↑◀"}</button>
            <div className="nav-sep" />
            <button
              className="nav-btn"
              onClick={() => navigate(-1)}
              disabled={loading || findingEdge !== null || !start}
              title="Previous window"
            >&#9664;</button>
            <button
              className="nav-btn"
              onClick={() => navigate(1)}
              disabled={loading || findingEdge !== null || !start}
              title="Next window"
            >&#9654;</button>
            <div className="nav-sep" />
            <button
              className="nav-btn nav-btn-edge"
              onClick={() => findEdge("next")}
              disabled={loading || findingEdge !== null || !start}
              title="Next rising edge (CAN-H > 3.3 V)"
            >{findingEdge === "next" ? <span className="spinner" style={{width:9,height:9,borderWidth:2}}/> : "↑▶"}</button>
          </div>
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">&nbsp;</span>
          <button
            className={`fetch-btn${loading ? " is-loading" : ""}`}
            onClick={fetchWaveform}
            disabled={loading}
          >
            {loading ? <><span className="spinner" />LOADING</> : "FETCH DATA"}
          </button>
        </div>

      </section>

      {/* ── Stats Row ──────────────────────────────── */}
      <div className="stats-row">
        <div className="stat-card">
          <span className="stat-lbl">Bus</span>
          <span className="stat-val">BUS {busId}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lbl">CAN-H Samples</span>
          <span className="stat-val mono c-high">{sampleCountH > 0 ? sampleCountH.toLocaleString() : "—"}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lbl">CAN-L Samples</span>
          <span className="stat-val mono c-low">{sampleCountL > 0 ? sampleCountL.toLocaleString() : "—"}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lbl">Time Span</span>
          <span className="stat-val mono">{fmtDuration(durationMs)}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lbl">Sample Rate</span>
          <span className="stat-val mono">{SAMPLE_RATE_LABEL}</span>
        </div>
        <div className="stat-card">
          <span className="stat-lbl">DB Status</span>
          <span className={`stat-val ${apiOk === true ? "c-ok" : "c-dim"}`}>
            {apiOk === true ? "ONLINE" : apiOk === false ? "OFFLINE" : "…"}
          </span>
        </div>
      </div>

      {/* ── Error Toast ────────────────────────────── */}
      {error && (
        <div className="error-toast">
          <span className="error-icon">⚠</span>
          {error}
        </div>
      )}

      {/* ── Chart Panel ────────────────────────────── */}
      <section className="chart-panel">
        {hasData && (
          <div className="chart-header">
            <span className="chart-title">Bus {busId} · CAN High &amp; CAN Low</span>
            <div style={{display:"flex", alignItems:"center", gap:10}}>
              <span className="chart-meta">
                {sampleCountH > 0 && (
                  <><span className="c-high">H: {sampleCountH.toLocaleString()} pts</span>{dataH.total_samples > sampleCountH ? <> <span className="downsample-badge">↓ {dataH.total_samples.toLocaleString()} total</span></> : null} · </>
                )}
                {sampleCountL > 0 && (
                  <><span className="c-low">L: {sampleCountL.toLocaleString()} pts</span>{dataL.total_samples > sampleCountL ? <> <span className="downsample-badge">↓ {dataL.total_samples.toLocaleString()} total</span></> : null} · </>
                )}
                {SAMPLE_RATE_LABEL} · {fmtDuration(durationMs)}
              </span>
              <button
                className={`chart-refresh-btn${loading ? " is-loading" : ""}`}
                onClick={fetchWaveform}
                disabled={loading}
                title="Re-fetch the current visible window"
              >{loading ? <span className="spinner" style={{width:9,height:9,borderWidth:2}}/> : "⟳"}</button>
            </div>
          </div>
        )}

        {!hasData && !loading && (
          <div className="chart-empty">
            <span className="chart-empty-icon">◈</span>
            <span>Select a bus and time range — then press FETCH DATA</span>
          </div>
        )}

        {loading && !hasData && (
          <div className="chart-empty">
            <span className="spinner" style={{width:22,height:22,borderWidth:3}} />
            <span>Querying database…</span>
          </div>
        )}

        {!hasData && (dataH || dataL) && !loading && (
          <div className="chart-empty">
            <span className="chart-empty-icon">◫</span>
            <span>No data found in this range.</span>
            <button className="chart-refresh-btn" onClick={fetchWaveform} style={{marginLeft:10}}>⟳ Retry</button>
          </div>
        )}

        {showChart && (
          <div ref={plotDivRef}>
          <Plot
            data={(() => {
              const hProc = sampleCountH > 0 ? processTrace(dataH.times, dataH.samples_raw) : null;
              const lProc = sampleCountL > 0 ? processTrace(dataL.times, dataL.samples_raw) : null;
              const allGaps = [...(hProc?.gaps ?? []), ...(lProc?.gaps ?? [])];
              const gapX = [], gapY = [];
              for (const [t0, v0, t1, v1] of allGaps) {
                gapX.push(t0, t1, null);
                gapY.push(v0, v1, null);
              }
              return [
                ...(hProc ? [{
                  x: hProc.x, y: hProc.y,
                  type: "scatter", mode: "lines",
                  line: { width: 1, color: "#60a5fa" },
                  name: `Bus ${busId} CAN-H`,
                }] : []),
                ...(lProc ? [{
                  x: lProc.x, y: lProc.y,
                  type: "scatter", mode: "lines",
                  line: { width: 1, color: "#f97316" },
                  name: `Bus ${busId} CAN-L`,
                }] : []),
                ...(gapX.length > 0 ? [{
                  x: gapX, y: gapY,
                  type: "scatter", mode: "lines",
                  line: { width: 2, color: "#4ade80", dash: "dot" },
                  name: "Data gap",
                  showlegend: allGaps.length > 0,
                  hovertemplate: "Gap: no data<extra></extra>",
                }] : []),
              ];
            })()}
            layout={{
              paper_bgcolor: "transparent",
              plot_bgcolor: "#0d0d0d",
              font: { color: "#ffffff", family: "system-ui", size: 11 },
              dragmode: measureMode ? false : "pan",
              xaxis: {
                title: { text: "Local Time", standoff: 8, font: { color: "#e0e0e0", size: 10 } },
                color: "#ffffff",
                gridcolor: "#222222",
                linecolor: "#2a2a2a",
                zerolinecolor: "#2a2a2a",
                tickfont: { color: "#ffffff", size: 10 },
                type: "linear",
                // Plotly's minallowed stops the scroll wheel / box-zoom before going under 2 ms
                minallowed: MIN_WINDOW_S,
                // uirevision: constant during pan/zoom — Plotly ignores the range prop
                // and preserves the user's interactive zoom.  Bumped on explicit navigation
                // so Plotly accepts the new range and jumps to the requested position.
                uirevision: uiRevision,
                range: viewRange ?? (start
                  ? [new Date(start).getTime() / 1000,
                     new Date(start).getTime() / 1000 + WINDOW_MS / 1000]
                  : undefined),
                ...xTickProps,
              },
              yaxis: {
                title: { text: "Voltage (V)", standoff: 8, font: { color: "#e0e0e0", size: 10 } },
                color: "#ffffff",
                gridcolor: "#222222",
                linecolor: "#2a2a2a",
                zerolinecolor: "#2a2a2a",
                tickfont: { color: "#ffffff", size: 10 },
                range: [0, 5],
                fixedrange: true,
              },
              margin: { l: 62, r: 20, t: 8, b: 52 },
              height: 370,
              autosize: true,
              shapes: frameShapes,
              legend: { font: { color: "#e0e0e0", size: 11 }, bgcolor: "transparent" },
              hoverlabel: {
                bgcolor: "#141414",
                bordercolor: "#3b82f6",
                font: { color: "#ffffff", size: 11 },
              },
            }}
            onRelayout={handleRelayout}
            onClick={measureMode ? handlePlotClick : undefined}
            config={{
              displayModeBar: true,
              displaylogo: false,
              scrollZoom: !measureMode,
              modeBarButtonsToRemove: ["sendDataToCloud", "lasso2d", "select2d", "autoScale2d"],
              toImageButtonOptions: {
                format: "png",
                filename: `bus${busId}_HL_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}`,
                scale: 2,
              },
            }}
            revision={plotRevision}
            style={{ width: "100%" }}
            useResizeHandler
          />
          </div>
        )}
      </section>

      {/* ── Measure Tool + Decode Bar ───────────────── */}
      {hasData && (
        <div className="decode-bar">
          {/* Measure tool toggle */}
          <button
            className={`decode-btn measure-btn${measureMode ? " measure-active" : ""}`}
            onClick={() => { setMeasureMode(m => !m); setCursors([]); }}
            title={measureMode ? "Exit measure mode (click to place cursors)" : "Enter measure mode"}
          >
            {measureMode ? "✕ EXIT MEASURE" : "⊶ MEASURE"}
          </button>

          {/* Cursor readout */}
          {cursors.length > 0 && (
            <span className="measure-readout">
              {cursors.length === 1
                ? <>C1 = {fmtLocalTime(cursors[0])}</>
                : <>
                    <span className="measure-delta">{fmtMeasure(measureDeltaUs)}</span>
                    <span className="measure-detail">
                      &nbsp;· C1={fmtLocalTime(Math.min(cursors[0], cursors[1]))}
                      &nbsp;→ C2={fmtLocalTime(Math.max(cursors[0], cursors[1]))}
                    </span>
                  </>
              }
              <button
                className="cursor-clear-btn"
                onClick={() => setCursors([])}
                title="Clear cursors"
              >✕</button>
            </span>
          )}

          <div className="decode-bar-sep" />

          {/* Decode button */}
          <button
            className={`decode-btn${decoding ? " is-loading" : ""}`}
            onClick={decodeFrames}
            disabled={decoding}
          >
            {decoding ? <><span className="spinner" />DECODING…</> : "⊞ DECODE CAN FRAMES"}
          </button>
          {frames?.bit_annotations?.length > 0 && (
            <button
              className={`decode-btn${showBitLines ? " measure-active" : ""}`}
              onClick={() => setShowBitLines(v => !v)}
              title="Toggle red bit-boundary lines on chart"
            >⊟ BIT LINES</button>
          )}
          {sampleCountH > 0 && (
            <button className="download-btn" onClick={() => downloadCSV("H")}>
              ↓ CSV (H)
            </button>
          )}
          {sampleCountL > 0 && (
            <button className="download-btn" onClick={() => downloadCSV("L")}>
              ↓ CSV (L)
            </button>
          )}
          {hasData && (
            <button className="download-btn snapshot-btn" onClick={downloadPDF}>
              ↓ PDF SNAPSHOT
            </button>
          )}
          {frames && (
            <>
              <span className="decode-summary">
                {frames.frame_count} frames · {Math.round(frames.bit_rate_hz / 1000)} kbps · {frames.total_bits} bits
              </span>

            </>
          )}
          {decodeError && <span className="decode-err">⚠ {decodeError}</span>}
        </div>
      )}

      {/* ── Frame Table ────────────────────────────── */}
      {frames && frames.frame_count > 0 && (
        <section className="frames-panel">
          <div className="panel-divider"><span>Decoded CAN Frames — Bus {busId}</span></div>
          <div className="frames-scroll">
            <table className="frames-table">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>CAN ID</th>
                  <th>DLC</th>
                  <th>Data (hex)</th>
                  <th>ASCII</th>
                </tr>
              </thead>
              <tbody>
                {frames.frames.map((f, idx) => (
                  <tr key={idx} className={f.crc_ok ? "" : "row-err"}>
                    <td className="td-mono">{f.time_utc.replace("T", " ").replace("+00:00","")}</td>
                    <td className="td-mono td-id">{f.can_id_hex}</td>
                    <td className="td-mono">{f.dlc}</td>
                    <td className="td-mono td-data">{f.data_hex || "—"}</td>
                    <td className="td-mono td-text">{hexToText(f.data_hex)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Active Buses Footer ─────────────────────── */}
      {buses.length > 0 && (
        <footer className="bus-strip">
          <span className="bus-strip-lbl">Active on DB :</span>
          {buses.map(b => (
            <span
              key={`${b.bus_id}${b.channel}`}
              className={`badge ${b.channel === "H" ? "b-high" : "b-low"}`}
            >
              BUS {b.bus_id} {b.channel === "H" ? "HIGH" : "LOW"}
            </span>
          ))}
        </footer>
      )}

    </div>
    </ErrorBoundary>
  );
}
