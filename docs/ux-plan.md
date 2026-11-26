# OnlySubs UX plan

Goal: two pages only. `/` = player page (phone-first, one screen). `/admin` = master admin page (desktop-first, programmer/back-end feel: dense, monospace accents, tables, no cards-in-cards). Keep the existing database schema and API routes unless a step says otherwise. Keep all existing business logic (sub queue, commitments, settlements, claims) working.

## A1. Admin: one master page
- New route `/admin` that replaces `/admin/seasons`, `/admin/seasons/new`, `/admin/seasons/[seasonId]`, `/admin/seasons/[seasonId]/edit`. Old routes redirect to `/admin` (keep `?season=<id>` if they had one).
- Gate: server-side, only `profiles.is_admin = true`; everyone else is redirected to `/`.
- Top bar: season selector (dropdown of seasons + "New season"), season name input, Published badge, Save, Send invites.
- Body: one horizontal bar per session: `Day | Time | Dates (n selected)` as three dropdowns, then two bulk paste textareas side by side: "MMPs" and "FMPs". Under all session bars: `+ Add session`. Under that: Settings (collapsible).
- Session = weekday + start time + chosen dates + MMP/FMP regulars. Map to existing tables: auto-name the schedule/session (e.g. "Tuesday 7:00 PM"), derive first_week/last_week from min/max chosen date. Remove the "Schedule name" and "Session name" inputs.
- Dates dropdown: checklist of every occurrence of the chosen weekday from the next one after today through 6 months out (e.g. Tuesday chosen on Nov 26 2026 -> Dec 1 2026 ... Jun 1 2027). Also include any already-saved dates for this session (even past ones). Select all / clear. Unchecking a saved date makes it a no-game (cancelled) just like the old "Add No-Games" board, using the existing cancel logic; then delete the old no-games board UI.
- Additional season invitees (pool-only players) stays, as a bulk paste field under the sessions.

## A2. Bulk paste parsing
- One shared parser `lib/parse-roster-paste.ts`. Input is whatever the admin pastes from a spreadsheet, doc, or email list. Output: `{ name, email }[]` plus a list of lines it could not parse.
- Must handle: tab-separated columns in any order, comma/semicolon separated, `Name <email>`, `email (Name)`, email-only lines (name = blank, show warning), header rows (skip), extra columns (phone, gender, etc. ignored), blank lines, duplicates (dedupe by email, case-insensitive), stray quotes and whitespace.
- Under each textarea show a live preview: "12 players parsed" plus a small table of name/email, and any unparsed lines in red. Gender comes from which box (MMP/FMP) they were pasted in.
- Add a small self-check script for the parser (no test runner in this project).

## A3. Settings
- Collapsible "Settings" at the bottom of /admin containing: rules PDF upload/replace/remove, the existing Advanced Settings fields, "Reset responsiveness score", Delete season.
- Reset responsiveness score: sets pings_received and pings_answered_in_time to 0 for every player in this season (player_season_stats). Confirm dialog first. New admin API route; use the existing authorizeAdmin pattern.

## B. Player page frame
- Page never scrolls; only the calendar scrolls. Fixed header and footer, each only as tall as one button row.
- Header: "OnlySubs", season name, gear button. Gear menu: Rules (PDF, if any), Admin (only if is_admin), Enable notifications, Sign out.
- Footer: the player's full name (profiles.full_name, not email) on the left; on the right a button "[n] active pings". Tapping it scrolls to the active ping card that expires soonest. Grey it out at 0.
- Remove every notice/banner above the calendar (ping banner, sub request status, "Your calendar" title, email line, Rules/day labels above the grid). Game-specific info lives only on game cards.
- Remove the floating "Admin menu" button from the player page.

## C. Calendar grid
- Columns = the distinct weekdays the season has games on, ordered Sun..Sat. Rows = calendar weeks (Sun-Sat) from the season's first game week through its last game week. Exchange Log / Settle Up cards come after the final week.
- Every cell in that range gets a card: if there is no game that day (session over, not started yet, or cancelled) it gets a grey "No game" card.
- The scroll area spans the full page width (edge to edge) so there is a safe margin to scroll with a finger; the cards themselves stay centered with padding.
- Keep the existing auto-scroll to the next game on load.

## D. Active ping card
- Keep the yellow glow and pinging dot. Move the dot off the game time to the empty space left of the status text.
- Add "Respond by 6:59PM" to the right of the status text: the ping timeout minus one minute, in the season timezone, h:mmAM/PM format.

## E. Notifications
- Delete every push notification except the "you've been pinged for a game" one (remove "Sub found" and "Sub request exhausted" pushes; leave admin emails alone).
- The ping push opens `/?game=<gameId>` and the page scrolls to and highlights that card. Update public/sw.js notificationclick to focus an existing tab and navigate it if one is open.
