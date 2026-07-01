# Octagon Booker

Playwright automation for Roosevelt Island Operating Corporation tennis court reservations at the Octagon courts via Civic Permits.

This project is built around the published rules from RIOC:

- Reservations are required.
- Reservations can only be made two days in advance.
- Submission window is Monday through Friday, 8:00 AM to 4:00 PM.
- Monday and Tuesday reservations may be submitted on Fridays.
- Same-day reservations must be submitted by 3:00 PM on weekdays.
- Tennis booking on Civic Permits is court-specific. The bot tries configured court labels in order until one works, starting with Court 3 by default.

Use this conservatively. Civic Permits terms reserve the right to terminate access for abusive or unauthorized use. The default mode is `safe`, which stops before final submission.

## Setup

1. Install dependencies:

```bash
cd /path/to/octagon-booker
npm install
npx playwright install chromium
```

2. Copy the sample environment file and adjust it:

```bash
cp .env.example .env
```

3. Capture a logged-in session:

```bash
npm run bootstrap-login
```

That command opens a browser. Log in manually, finish any email verification or prompts, and the script will save your authenticated session to `.auth/storage-state.json`.

## Usage

Dry run and planning only:

```bash
PLAN_ONLY=true npm run book:dry
```

Safe mode, fill the form but do not submit:

```bash
MODE=safe DRY_RUN=false npm run book
```

Auto-submit mode:

```bash
MODE=auto DRY_RUN=false HEADLESS=true npm run book
```

## How date targeting works

- If `TARGET_DATE` is set as `YYYY-MM-DD`, the script tries only that date.
- Otherwise it uses the RIOC rule set:
  - Every day: target `today + 2 days`
- The script filters those dates against `PREFERRED_WEEKDAYS`.

## Notifications

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, the script sends Telegram updates for:

- reservation plan
- safe-mode ready state
- success
- failure

## Cron examples

Run every day at 8:00 AM New York time in safe mode:

```cron
TZ=America/New_York
0 8 * * * cd /path/to/octagon-booker && /usr/bin/env MODE=safe DRY_RUN=false /usr/bin/npm run book >> logs/cron.log 2>&1
```

With the current defaults, that run targets the `20:00` to `21:00` court slot.

Run every Friday at 8:00 AM and try Monday and Tuesday automatically:

```cron
TZ=America/New_York
0 8 * * 5 cd /path/to/octagon-booker && /usr/bin/env MODE=auto DRY_RUN=false HEADLESS=true /usr/bin/npm run book >> logs/cron.log 2>&1
```

Create the logs directory first if you use those cron entries:

```bash
mkdir -p logs
```

## Notes on selectors

The booking flow after login is driven by the live Civic Permits form structure:

- `New Permit Request`
- `Activity`
- `Location Requested` with concrete court options such as `Octagon Tennis Court 1`
- `Add Facility`
- `Tennis Courts` checkbox
- `+ Add repeating dates`
- `Add dates`
- `Add & Confirm`
- `Submit`

If Civic Permits changes labels or field layouts, update the helper locators in `src/book.js`.

## C++ Version (Experimental)

A standalone C++ client is available in `cpp/`.

Build:

```bash
cd cpp
cmake -S . -B build
cmake --build build -j
```

Run in safe mode (no submit):

```bash
MODE=safe ./build/octagon_booker_cpp
```

Run in auto mode (requires auth cookie string):

```bash
MODE=auto CIVIC_COOKIE='name=value; name2=value2' ./build/octagon_booker_cpp
```

Behavior:

- Tries +2 day plan first
- Falls back to +1 day only if +2 day attempts all fail
- Tries courts in priority order (Court 3 first)

Note: the C++ path posts directly to `/Permits` using known response IDs/facility IDs and is provided as an experimental alternative to the Playwright flow.