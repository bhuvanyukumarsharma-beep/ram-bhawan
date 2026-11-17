# For developers

This folder is the full source of the Ram Bhawan app. You do not need it to use the app.

- `app/` is the website (React + TypeScript + Vite). `npm install && npm run build` makes `app/dist`.
- `supabase/sql/` holds the database in numbered parts. `./build.sh` joins them into `supabase/setup.sql`.
- `supabase/functions/notify/index.ts` is the delivery function (Web Push and Gmail).
- `supabase/schedule.sql` is the daily clock (pg_cron and pg_net).
- `package/` builds the download: `python3 package/build.py`.
- `tests/` has the test suites. They need Node 22 and a local PostgreSQL (see `tests/db.mjs`).
  `node ledger.test.mjs`, `node api.test.mjs`, `node webpush.test.mjs`, `node grants.test.mjs`, `node keys.test.mjs`,
  and the phone-size browser walk-throughs in `tests/ui/`.
- `GUIDE.md` is the owner's step-by-step guide.
