# canui

canui is the **waveform viewer** for the CAN bus recording system. It is a React + Plotly.js single-page application that renders the raw CAN-H and CAN-L analog waveforms stored in [candb](https://github.com/forrest-molg/candb), overlays decoded CAN frame bit boundaries and field annotations, and provides oscilloscope-style pan, zoom, and measurement tools.

## System Context

```
candb FastAPI (port 8000)
  │
  ├─ GET /query     ◄──── pan / zoom triggers auto-refetch
  ├─ GET /decode    ◄──── bit annotation overlay
  ├─ GET /find_edge ◄──── prev/next frame navigation
  └─ GET /storage   ◄──── disk free widget
         │
   canui (port 3000)   ◄── served by ui_server.py (Python HTTP)
         │
   Browser (any device on the same network)
```

## What Is Implemented

### Waveform display

- **Plotly.js chart** rendering CAN-H (blue) and CAN-L (orange) voltage traces simultaneously.
- **Automatic min-max downsampling** on the server — up to 8,000 display points regardless of zoom level, with every edge transition preserved.
- **Gap detection**: breaks in the waveform (e.g. missing chunks) are shown as a gap rather than a false horizontal line bridging the missing data.
- **Fixed x-axis labels**: three evenly-spaced time labels that update as you pan/zoom, without label crowding.

### Pan and zoom

- **Mouse wheel / trackpad** zoom and drag pan via Plotly's built-in interaction.
- **Auto-refetch on zoom**: any zoom change > 1% triggers a debounced server fetch (200 ms) at the correct resolution for the new viewport. Data is never reused at the wrong zoom level.
- **2 ms minimum window**: enforced at three layers — relayout clamp, fetch expansion, and `xaxis.minallowed` — so zooming in past bit-level resolution never produces a blank chart.
- **Pan within loaded range**: panning within the already-fetched window skips the network round-trip.
- **`uiRevision` management**: Plotly's zoom state is preserved during pan (no chart reset), and only explicitly reset when new data is loaded at a different range.

### Bit-boundary overlay

- Toggle with the **Bit Lines** button. When enabled, a vertical line is drawn at the sample-point of every decoded CAN bit, colour-coded by field (SOF, ID, DLC, DATA, CRC, ACK, EOF).
- Lines are filtered to the visible viewport ±15% buffer and capped at 800 shapes to maintain render performance.

### Frame decode table

Decoded CAN frames for the current view window are shown in a scrollable table:

| Column | Content |
|---|---|
| Time UTC | Frame start timestamp (microsecond precision) |
| CAN ID | 11-bit ID in hex (e.g. `0x1A4`) |
| DLC | Data length code (0–8) |
| Data | Data bytes in hex |
| ASCII | Printable ASCII representation of the data bytes |

### Navigation

- **Prev / Next window buttons**: jump back or forward by one current window width.
- **Refresh button**: re-fetch the current viewport at the current zoom level.
- **Start time input + Go button**: jump to any arbitrary UTC timestamp.

### Cursor measure tool

- Click the **Cursors** button to enter measure mode.
- Click two points on the waveform — a Δt readout appears showing the time difference in µs, ms, or s.
- In measure mode the minimum zoom window is relaxed from **2 ms to 200 µs**, allowing you to zoom in to individual CAN bits (8 µs at 125 kbps) for precise cursor placement.
- Scroll-wheel zoom is disabled in measure mode (so wheel scrolls the page rather than the chart); use the Plotly box-zoom tool instead.

### Storage widget

Displays available disk space on the candb host, fetched from `/storage`. Updates on page load.

### PDF export

The **Download PDF** button captures the current waveform chart as a PNG via `Plotly.toImage`, embeds it in a PDF, and appends the decoded frame table using `jspdf-autotable`. The PDF is named with the current start timestamp.

### CSV export

The **Export CSV** button downloads full-resolution raw samples (no downsampling) for the current viewport as a CSV file with columns `time_unix_s`, `time_utc`, `voltage_v`. Limited to 60-second windows.

## File Structure

```
canui/
├── src/
│   ├── App.jsx         # All UI logic — chart, controls, decode table, PDF export
│   ├── App.css         # Dark oscilloscope-style theme
│   ├── main.jsx        # React entrypoint
│   └── index.css       # Global reset
├── public/
│   ├── favicon.svg
│   └── icons.svg
├── index.html
├── package.json
└── vite.config.js
```

The built output (`dist/`) is served by `ui_server.py` at `/opt/candb/` on port 3000.

## Key Constants (`src/App.jsx`)

| Constant | Value | Meaning |
|---|---|---|
| `API` | `http://100.113.84.82:8000` | candb API base URL — change this for a different host |
| `WINDOW_MS` | `10` | Default display window width (ms) on first load |
| `MIN_WINDOW_S` | `0.002` | Minimum zoom window in normal mode (2 ms — ~25 CAN bits) |
| `MIN_WINDOW_MEASURE_S` | `0.0002` | Minimum zoom window in measure mode (200 µs — ~2.5 CAN bits) |
| `GAP_THRESH_S` | `0.002` | Gap threshold for null-break insertion in traces |

## Build and Deploy

### Prerequisites

- Node.js 18+ and pnpm (or npm)
- candb API reachable at the URL set in `API` constant

### Build

```bash
cd /opt/canui
npm install     # or: pnpm install
npm run build   # output → dist/
```

### Serve

The built `dist/` directory is served by a small Python HTTP server:

```bash
python3 /opt/candb/ui_server.py
# Listening on port 3000
```

Open **http://\<candb-host\>:3000** in any browser.

### Changing the API host

Edit `src/App.jsx` line:

```jsx
const API = "http://<your-candb-host-ip>:8000";
```

Then rebuild: `npm run build`

## Development Mode

```bash
npm run dev
# Vite dev server with HMR at http://localhost:5173
```

During development, Vite proxies API calls if you add to `vite.config.js`:

```js
server: {
  proxy: {
    '/query': 'http://localhost:8000',
    '/decode': 'http://localhost:8000',
    // etc.
  }
}
```

## Releasing a New Version

```bash
git checkout develop    # all work on develop branch
# ... implement features, test, commit ...

git checkout main
git merge develop
git tag -a v1.1 -m "v1.1 — describe changes"
git push origin main && git push origin v1.1

# Then rebuild on the Geekom:
cd /opt/canui && npm run build
```

