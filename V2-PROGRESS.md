# Ram Bhawan version 2: progress

Instructions: RAM-BHAWAN-V2-PROMPT.txt (same folder). After a restart read that file and this one, then carry on.

## How to run the tests on this computer (Windows, no WSL, no Docker)

- Test database: a private PostgreSQL 18 from the npm package "embedded-postgres", kept OUTSIDE the project in
  `C:\rb-tools` (data in `C:\rb-tools\data`, UTF-8, no password, port 54329).
  Start it (Git Bash): `cd /c/rb-tools && (node start-pg.mjs > pg.log 2>&1 &)` then wait for "PG READY" in pg.log.
  Stop it: stop only the process whose command line has `start-pg.mjs` and the pid in `C:\rb-tools\data\postmaster.pid`.
- Every test command needs: `export PATH="/c/rb-tools/pyenv/Scripts:/c/rb-tools/bin:$PATH"`
  (gives `python3` with markdown, pymdown-extensions, pillow; and a stand-in `setsid`).
- `C:\tmp` is a link to the Git Bash `/tmp` folder, so bash scripts and Node agree on `/tmp`.
- Database suites: `cd tests && node ledger.test.mjs` (also api, webpush, grants, keys, later upgrade and the new ones).
- Website: `cd app && npm run build`. Package: `PYTHONIOENCODING=utf-8 python3 package/build.py --no-build`.
- Browser walks: `cd tests/ui && bash run_all.sh` and `HTTPS=1 bash run_all.sh` (about 4 minutes each).

## Baseline (version 1, before any change) - all passed on 14 Nov 2026

| Suite | Passed |
|---|---|
| ledger.test.mjs | 12 |
| api.test.mjs | 28 |
| webpush.test.mjs | 8 |
| grants.test.mjs | 7 |
| keys.test.mjs | 30 |
| browser walks (http) | owner 27, tenant 19, alerts 5, setup 4 |
| browser walks (https) | owner 27, tenant 19, alerts 5, setup 4 |

## Latest results (update this table as work goes on)

| Suite | Passed | When |
|---|---|---|
| upgrade.test.mjs | 23 | end of Phase 2 |
| v2.test.mjs (new features) | 59 | end of Phase 2 |
| ledger2.test.mjs (old dues vs independent calculation, 400 random cases) | 7 | end of Phase 2 |
| ledger.test.mjs / api.test.mjs / webpush.test.mjs (version 1, unchanged) | 12 / 28 / 8 | end of Phase 2 |
| grants.test.mjs | 9 of 11; the other 2 need the website to call the 10 new functions (Phase 3) | end of Phase 2 |

Frozen version 1 database: tests/fixtures/setup.v1.sql, SHA-256 matches
ed3a94ca4e3e95c019342ed06bd1aa0c361340bc752f2f6abd677c6dc49e5575.

## Checklist

### Set-up (A1)
- [x] Backup to `for-developers-v1-backup` (beside this folder), git started, first commit
- [x] Tools installed (see above)
- [x] Baseline proven
- [x] Version 1 database frozen and checksum matched
- [x] This file
- [x] Read all the code (A1.1) - database read in full; website files are re-read at the start of Phase 3

### Phase 1: database foundations
- [x] build.sh makes setup.sql and database-update.sql
- [x] tests/upgrade.test.mjs (E1)
- [x] Schema changes (delta + 01_schema.sql)
- [x] _log, _bill_label
- [x] _ledger changes (a)-(e), _tenancy_view hides 'by' from tenants
- [x] Version marker (public_info, _settings_json)
- [x] wipe / export changes

### Phase 2: database features (tests first)
- [x] C1 old dues
- [x] C2 delete bill
- [x] C8 lodging_list + log lines everywhere
- [x] C3 documents
- [x] C5 payments_month, edit_payment
- [x] C6 building_bill
- [x] C7 send_reminder
- [x] Whitelist + grants test, no double overloads (2 grants checks wait for the website to call the new functions)
- [x] Gate: all database suites green (see table)

### Phase 3: website
- [ ] (1) Theme tokens, five themes, contrast test
- [ ] (2) Version gate, monthLabel guard, confirmation sheet, route query, NOTIFYING, document picker
- [ ] (3) Rooms boxes
- [ ] (4) Billing: Bills and Payments views
- [ ] (5) Room page (buttons, bill card, Documents, History, + Old dues, rent tick, move-in form)
- [ ] (6) Share sheet
- [ ] (7) Lodging tab
- [ ] (8) Settings, tenant Me, sign-in, Receipt, tenant app, Inbox
- [ ] (9) Walk-throughs and screenshots at 390 px in all themes

### Phase 4: update path and package
- [ ] database-update.txt, update-helper.html, public/_headers
- [ ] package/build.py (v2 zip)
- [ ] GUIDE.md and START-HERE.html
- [ ] Developer README

### Phase 5: final proof
- [ ] Every suite and walk (http and https)
- [ ] Package built, unpacked, walks against the unpacked website, update helper end to end
- [ ] Definition of Done ticked
- [ ] PROJECT-NOTES-V2.md
- [ ] Final report

## Calls I made

- Test database: no PostgreSQL, Docker or WSL on this computer and installing those needs administrator clicks and a
  restart. Used the free npm package "embedded-postgres" (real PostgreSQL 18) in `C:\rb-tools`, outside the project.
  It is a developer tool only; nothing in the app depends on it.
- Playwright added to tests/package.json (a test tool, not part of the website).
- Lodging lines are protected by a database trigger (`audit_log_guard`): any update or delete of a line is refused, except
  the database clearing `actor_id` when a user is deleted, and the "start fresh" wipe. This makes "nobody can edit or
  delete lines" true even for a future mistake in a function.
- `_ledger` sort order got two extra tie-break keys (created_at, id). Needed because several old dues can share one due
  date; without it the order (and so which one is paid first) could change between calls. Version 1 data is unaffected
  (the upgrade test proves ledgers are identical).
- Lodging groups: payment.* -> payments; bill.*, dues.*, adjustment.*, reading.*, claim.* -> bills; settings.*, team.*,
  backup.*, data.* -> settings; everything else (tenant.*, room.*, document.*, ticket.*, reminder.*) -> tenants.
- Switching a TENANT login off/on and resetting a TENANT password are logged as tenant.login_switched_off/on and
  tenant.password_reset (team.* is used for masters).
- delete_bill now says "Bill not found" when the bill is already gone (version 1 did nothing silently).
- add_bill refuses a month before the year 2000 ("Choose a month"), so nobody can make a monthly bill on the old-dues
  placeholder month.
- Tests set "bill day" to the 28th so that running the daily reminders for a test date does not add bills to everyone.
- Order of work in Phase 2: the tests for C1 were written before its code. For C2, C3, C5, C6, C7 and C8 the code was
  written first and the tests straight after (same sitting, before anything was called done). All pass.
- Document size limits are counted on the stored text (base64), as the instruction says: a photo up to 850,000
  characters (the browser aims for 800,000), a PDF up to 1,600,000 characters (a PDF file of about 1.1 MB).
- send_reminder: the 30-minute limit looks at the tenant's last "reminder" alert. An app alert is refused when nothing
  is due ("Nothing is due from this tenant right now") and when the tenant has no login. There is also a 'copy' line.
- building_bill: "Paid" is worked out as this month + interest - what is still owed on this bill, so the identity
  (this month + interest - paid + other dues = to pay) holds for every line, also in odd cases (a bill made negative
  by deductions). A tenant who had not yet moved in during the month shown is left out, as the instruction says.
- lodging_list: p_q also understands "room:101" (exactly Room 101), used by the room filter. Signature unchanged.
- tenancy_detail / room_detail (masters only) also carry `last_reminder` and the number of `documents`.
- receipt() also returns edited_at, edit_note and, for masters only, the tenant phone (for "Share receipt").
- tests/ledger2.test.mjs is a NEW file: old dues against an independent day-by-day calculation. The version 1 file
  ledger.test.mjs is untouched.
- New internal helpers beyond the list in C10: _who, _who_p, _d, _n, _diff, _method_name, _ledger_for_tenant, _audit_log_guard.
- The interest preview lives in app/src/lib/dues.ts (pure function `oldDuesInterest`), tested against _ledger.
- Saved the owner's instruction text as RAM-BHAWAN-V2-PROMPT.txt because it was pasted into the chat and was not on disk.

## Differences found

- (none yet)

## Test changes and why (rule 4)

- tests/grants.test.mjs, tests/keys.test.mjs, tests/ui/shim.mjs, tests/ui/site_from_helper.mjs: file paths were read with
  `new URL(...).pathname`, which breaks on Windows (drive letters, spaces in "VS CODE"). Changed to `fileURLToPath(...)`.
  tests/ui/shim.mjs: the website folder path is now `path.resolve(...)` so the "inside the folder" check works on Windows.
  No assertion was touched; the same checks run.
- tests/db.mjs: can read PG* environment variables (defaults unchanged) and can load another SQL file (the frozen
  version 1) for the upgrade test.
- tests/grants.test.mjs: the "exactly the functions the app calls" check now allows `billing_month` as well (kept open
  on purpose for phones still showing the version 1 website, as the instruction says). New checks were added (version 2
  functions called by the website, no double overloads, "_" helpers closed, Lodging and Documents tables unreachable).

## What the owner must do

- Nothing yet.

## Open problems

- (none yet)
