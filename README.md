# Shift Coverage App

A Progressive Web App for Inverness Country Club racquet-sports staff to swap shift coverage and keep it fair with a points system.

**Live app:** https://drtennisman.github.io/shift-coverage-app/

## How it works

- **Board** — post a shift you need covered, or claim someone else's. Posting gives you **-1**, covering gives you **+1**. You can reclaim your own post ("I'll Work It") to net back to 0, or cancel it to reverse the -1.
- **Home** — a live 2-week schedule built from the weekly template, showing who's working, what needs coverage (red), what's been covered (green), and unfilled **Open** shifts anyone can claim for +1.
- **Scores** — the running coverage balance for each staff member.
- **History** — recent covers (self-covers aren't logged).
- **Admin** — PIN-gated: manage staff, delete shifts (reverses scores), reset all scores. Also shows whether the deployed backend version matches the app.

Emails go to all staff when a shift is posted, and to the poster + manager when one is claimed.

## Architecture

| Piece | Where | Notes |
|-------|-------|-------|
| `index.html` | GitHub Pages | The entire frontend — vanilla JS/CSS, no build step |
| `google-apps-script.js` | Google Apps Script web app | All reads/writes; deployed manually (see below) |
| Google Sheet | Google Drive | The database — 5 tabs (below) |
| `sw.js` / `manifest.json` | GitHub Pages | PWA install + offline shell. Bump `CACHE_NAME` on every frontend change |

## Google Sheet tabs

| Tab | Headers |
|-----|---------|
| **Shifts** | `ID, PostedBy, ShiftDate, StartTime, EndTime, Location, Notes, Status, ClaimedBy, PostedAt, ClaimedAt` |
| **History** | `ID, PostedBy, CoveredBy, ShiftDate, CompletedAt` |
| **Staff** | `Name, Score, IsAdmin, Email` — one row per person; admin rows have `IsAdmin = TRUE` |
| **Config** | `Key, Value` — rows: `AdminPIN`, `ManagerEmail` (always notified) |
| **Schedule** | `Day, Time, Location, Staff` — weekly template. `Day` = "Monday" etc., `Time` is a display string like `8:00 AM - 2:00 PM`. Put **Open** in Staff for unfilled shifts staff can claim for +1 |

Shift `Status` values: `open` → `claimed`, or `expired` (auto-set when an open shift's date passes).

## Deploying changes

**Frontend** (`index.html`, `sw.js`): bump `CACHE_NAME` in `sw.js`, commit, push to `main`. GitHub Pages serves it automatically within a couple of minutes.

**Backend** (`google-apps-script.js`):
1. Bump the `VERSION` constant at the top of the file **and** `APP_VERSION` in `index.html` (keep them equal).
2. Copy the whole file and paste it over the code in the Apps Script editor (attached to the Google Sheet via Extensions → Apps Script).
3. Deploy → Manage deployments → ✏️ edit → **Version: New version** → Deploy.
   *Skipping "New version" keeps the old code running — this is the #1 gotcha.*
4. Verify: open the app's Admin tab — it shows "backend up to date ✓" (or hit `<web app URL>?action=ping` and check the `version` field).

If emails ever stop sending after a fresh authorization is needed, run any function from the Apps Script editor once and approve the Gmail permission prompt.
