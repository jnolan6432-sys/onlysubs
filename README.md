# OnlySubs

A Next.js App Router starter for finding rec-league subs, with Supabase
passwordless email authentication, a Home Screen installable PWA, and Web Push
subscription storage.

## Local setup

1. Install Node.js 20.9 or later and run `npm install`.
2. Copy `.env.example` to `.env.local`. Set the Supabase project URL and
   anon/publishable key from **Project Settings → API**. Set
   `SUPABASE_SERVICE_ROLE_KEY` from the same page for server-only season
   account provisioning, and set `NEXT_PUBLIC_SITE_URL` to the canonical app
   origin.
3. Run the migrations in `supabase/migrations/` in filename order using the
   Supabase SQL Editor or Supabase CLI.
4. In **Authentication → URL Configuration**, set the site URL to your
   deployed origin and add `http://localhost:3000/auth/callback` and
   `https://your-domain.example/auth/callback` to the redirect URL allow-list.
   Enable Email as an auth provider and use the `{{ .ConfirmationURL }}` link in
   the email template so the magic link returns to the callback route.
5. Run `npm run dev`. `npm run build`, `npm run lint`, and `npm run typecheck`
   validate the app.

The Supabase auth client refreshes and persists its session in secure,
same-site cookies. No application-level sign-out timer is set. Supabase project
session limits can still end a session; leave the **time-box** and **inactivity
timeout** limits disabled in **Authentication → Settings → Sessions** if users
should remain signed in until they explicitly sign out or revoke access.

New auth users get a `profiles` row automatically. To grant an administrator,
update that user's `profiles.is_admin` value in the Supabase SQL Editor; clients
cannot change their own admin flag. RLS is enabled on all application tables.

## Admin season builder

Administrators can use the top-right menu to build a season or manage existing
seasons. The season directory lists published and draft seasons with session,
date, and player counts, and lets admins edit seasons or send magic links to
players who have not signed in yet. Admins can also permanently delete a season
after confirmation; associated schedules and player commitments are removed
through cascading foreign keys. The builder lets admins select dates for
each session, assign session rosters, and add invitees to the season pool
without a regular session assignment. Applying
`supabase/migrations/20261114180000_season_builder.sql` adds the pool membership
table and transactional publishing function. Publishing provisions auth users
without sending email; use **Send Invites** to send a Supabase passwordless
magic link to each pool member who has not signed in yet. Configure Supabase
Auth email delivery and allow-list `${NEXT_PUBLIC_SITE_URL}/auth/callback`.
Roster and game-date changes automatically create any missing player game
commitments in the same database transaction.

Only players with `profiles.gender_match` set to `FMP` or `MMP` are added to
that matching queue. Players whose gender match is unset remain in the season
pool and are added to the appropriate queue after profile setup. Editing
preserves games with commitments or substitute requests; those dates remain
selected and cannot be removed.

`supabase/migrations/20261115010000_sub_queue_engine.sql` adds the transactional
queue engine, IANA timezone-aware daytime timers, ping accept/pass handling,
and notification delivery state. Vercel deployments on a plan that supports
per-minute cron jobs use `vercel.json` to call `GET /api/cron/sub-queue`;
set `CRON_SECRET` in the deployment environment. For other hosts, schedule the endpoint with
`Authorization: Bearer $CRON_SECRET`.

`supabase/migrations/20261115000000_calendar_workflow.sql` adds transactional
commitment toggles, read-only client access to commitments (all changes go
through server-verified database functions), and an admin no-game marker.
Current open sub requests are counted as the game card's slots to fill. When a
playing player requests a sub, the engine pings the next eligible player in
the selected queue; VAPID server environment variables must be configured for
delivery.

`supabase/migrations/20261117010000_paused_sub_request_workflow.sql` records
passes and timeouts, marks those players unavailable for the game, and pauses
requests when both queues have no eligible responders. Making an unavailable
player available again reactivates paused requests and immediately runs the
queue worker. Dropouts cannot be cancelled; a player can become available for
the game again, but can only return to playing by accepting a sub ping. The
`supabase/migrations/20261119000000_irreversible_sub_request_workflow.sql`
migration removes the cancellation RPC and allows an available request
originator to rejoin the candidate queue.

Each season has a league timezone for schedule display. Player browsers sync
their current IANA timezone to their profile; sub pings are dispatched only
during that player's configured daytime window, with the response timer paused
until their next local daytime window when needed.

`supabase/migrations/20261123000000_season_rules_pdfs.sql` adds the public
`season-docs` PDF bucket with a 10 MB limit and per-season rules document
metadata. Admins can upload, replace, or remove a PDF from the season builder;
players can open it from the calendar season header or while joining a season.

`supabase/migrations/20261124000000_admin_gendered_invites_and_commitments.sql`
removes the requirement for players to complete onboarding. Admin roster
selections set `profiles.gender_match`, all invited pool members are marked
onboarded, and every game receives a default Unavailable commitment unless the
player is a regular in that session, which receives Playing.

`supabase/migrations/20261121000000_gendered_claim_windows.sql` adds the
season game price and configurable gender-first and global last-minute claim
windows. Open sub slots are shown by gender; automated pings pause at the start
of the claim phase, and eligible non-playing players can claim a spot until
game start. A claim records its fill method and amount, with free claims
recorded as zero. The game start cutoff is enforced by database functions and
commitment triggers.

`supabase/migrations/20261122000000_season_sub_settlements.sql` snapshots each
game's regular roster and financial settings, then records an exchange at game
start only when a substitute is playing in a regular's spot. After the final
game starts, season balances are netted into payment instructions. Debtors can
confirm payments from the Settle Up card, and creditors see those confirmations.
Run this migration in Supabase before using the post-season exchange and payment
cards.

Onboarding collects a gender match, a default availability preference, and an
optional device push subscription. The selected season's roster games are
marked `playing`; other games are initialized to `available` or `unavailable`
based on the preference. Players are appended to their gender queue regardless
of that default, so they can be marked available for individual dates later.
If a player has pool memberships in more than one published season, onboarding
asks which season to join and confirms removal from other season pool
memberships. Historical roster assignments, commitments, and queue entries in
those other seasons are retained.

## Install and push notifications

The manifest, app icons, and `/sw.js` provide installability and display
incoming push payloads. Serve the app over HTTPS (localhost is also supported).
Generate a VAPID key pair with `npx web-push generate-vapid-keys`, then set the
public key as `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, the private key as
`VAPID_PRIVATE_KEY`, and a `mailto:` or HTTPS contact as `VAPID_SUBJECT`. Keep
the private key in a trusted server environment; never expose it to the browser.
The enable-notifications button asks for permission, subscribes this device, and
stores the subscription in `push_subscriptions`. New substitute requests send
push alerts with Accept Spot and Pass actions to the next eligible player.

On iPhone/iPad, users must add the site to the Home Screen and open the
installed app before granting notification permission (iOS/iPadOS 16.4+).
