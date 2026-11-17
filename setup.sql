-- =====================================================================
-- Ram Bhawan - property manager. PART 1: tables
-- Run the whole of this file once, on a brand-new Supabase project (guide, Step 4).
-- Every table is locked (row level security ON, no policies): nobody can read
-- or change data directly. All access goes through the functions in parts 2-6,
-- which check who is asking before doing anything.
-- =====================================================================
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table app_settings (
  id int primary key default 1 check (id = 1),
  building_name text not null default 'Ram Bhawan',
  timezone text not null default 'Asia/Kolkata',
  water_rate numeric(10,2) not null default 100,        -- rupees per person per month
  electricity_rate numeric(10,2) not null default 10,   -- rupees per unit
  interest_rate numeric(6,2) not null default 24,       -- percent per year, simple, charged daily
  grace_days int not null default 0,
  bill_day int not null default 1 check (bill_day between 1 and 28),
  reminder_days int[] not null default '{5,3,1,0}',
  receipt_prefix text not null default 'RB',
  upi_id text,                                           -- shown to tenants so they know where to pay
  app_url text,                                          -- this app's web address; saved automatically when the owner signs in, used in email links
  updated_at timestamptz not null default now(),
  schema_version int not null default 2                  -- which version of the database this is; the website reads it first
);
insert into app_settings (id) values (1);

create table users (
  id uuid primary key default gen_random_uuid(),
  login_id text not null,
  password_hash text not null,
  role text not null check (role in ('owner','admin','tenant')),
  full_name text not null,
  email text, phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index users_login_uq on users (lower(login_id));

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  device text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table login_attempts (
  login_id text primary key,
  fails int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  room_no text not null unique,
  floor text,
  default_rent numeric(10,2) not null default 0,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table tenancies (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  user_id uuid references users(id) on delete set null,
  full_name text not null,
  phone text, email text,
  persons int not null default 1 check (persons >= 0),
  rent numeric(10,2) not null check (rent >= 0),
  due_day int not null default 5 check (due_day between 1 and 28),
  deposit numeric(10,2) not null default 0,
  start_date date not null default current_date,
  end_date date,
  opening_reading numeric(12,2) not null default 0,
  emergency_contact text, id_proof text, notes text,
  status text not null default 'active' check (status in ('active','ended')),
  created_at timestamptz not null default now()
);
create unique index tenancies_one_active on tenancies (room_id) where status = 'active';
create index tenancies_user_idx on tenancies (user_id);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  data text not null,                       -- small compressed photo as a data URL
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  month date not null,                      -- first day of the month billed
  rent numeric(10,2) not null,
  persons int not null,
  water_rate numeric(10,2) not null,
  water numeric(10,2) not null,
  prev_reading numeric(12,2) not null default 0,
  new_reading numeric(12,2),
  elec_rate numeric(10,2) not null,
  electricity numeric(10,2) not null default 0,
  reading_photo uuid references attachments(id) on delete set null,
  reading_by uuid references users(id) on delete set null,
  reading_at timestamptz,
  reading_verified boolean not null default false,
  due_date date not null,
  interest_waived boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  kind text not null default 'regular' check (kind in ('regular','previous'))   -- 'previous' = "Old dues" entered by hand
);
-- One regular bill per tenant per month; old dues may be several.
create unique index bills_one_regular_per_month on bills (tenancy_id, month) where kind = 'regular';

create table bill_adjustments (            -- negative amount = deduction, positive = extra charge
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills(id) on delete cascade,
  label text not null,
  amount numeric(10,2) not null,
  claim_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index bill_adj_idx on bill_adjustments (bill_id);

create sequence receipt_seq;
create table payments (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  paid_on date not null,
  method text not null check (method in ('cash','upi','bank','other')),
  reference text, note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','void')),
  submitted_by uuid references users(id) on delete set null,
  by_tenant boolean not null default false,
  receipt_no text unique,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  proof uuid references attachments(id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,                     -- set when a master corrects an approved payment
  edited_by uuid references users(id) on delete set null,
  edit_note text
);
create index payments_idx on payments (tenancy_id, status);

create table deduction_claims (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  description text not null,
  requested numeric(10,2) not null check (requested > 0),
  approved numeric(10,2),
  bill_id uuid references bills(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  proof uuid references attachments(id) on delete set null,
  decision_note text,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  kind text not null default 'maintenance' check (kind in ('maintenance','complaint','other')),
  title text not null,
  details text,
  photo uuid references attachments(id) on delete set null,
  status text not null default 'open' check (status in ('open','seen','in_progress','done','closed')),
  owner_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null default 'info',
  title text not null,
  body text,
  link text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  sent_at timestamptz
);
create unique index notifications_dedupe on notifications (user_id, dedupe_key) where dedupe_key is not null;
create index notifications_unsent on notifications (created_at) where sent_at is null;
create index notifications_user on notifications (user_id, created_at desc);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now()
);

-- Lodging: one line for every change a master makes and every request that is decided. Lines are never changed.
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references users(id) on delete set null,
  actor_name text,                          -- name at the time; empty = done automatically
  actor_role text,
  action text not null,                     -- a short code, for example payment.approved
  group_name text not null check (group_name in ('payments','bills','tenants','settings')),
  summary text not null,                    -- the sentence shown on the Lodging screen
  room_no text,                             -- room and tenant at the time
  tenant_name text,
  tenancy_id uuid,                          -- no link on purpose: the line stays even if the tenant is deleted
  details jsonb                             -- before / after values
);
create index audit_log_at_idx on audit_log (at desc, id desc);
create index audit_log_tenancy_idx on audit_log (tenancy_id, at desc);

-- Lodging lines cannot be edited or deleted by any function of the app. (Only "start fresh" clears the table.)
create or replace function _audit_log_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('rb.wipe', true), '') = 'on' then return old; end if;
    raise exception 'Lodging lines cannot be deleted';
  end if;
  -- The only change allowed: the database clearing actor_id when that user is deleted. Everything else must stay as written.
  if new.actor_id is null and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then return new; end if;
  raise exception 'Lodging lines cannot be changed';
end $$;
create trigger audit_log_guard before update or delete on audit_log for each row execute function _audit_log_guard();

-- Documents kept with a tenant (Aadhaar photo, agreement). The file itself sits in "attachments".
create table tenant_documents (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  title text not null,
  attachment_id uuid not null references attachments(id) on delete cascade,
  mime text not null,
  size_kb int not null,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index tenant_documents_tenancy_idx on tenant_documents (tenancy_id, created_at);

-- Lock every table: no direct access from the internet.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
-- =====================================================================
-- PART 2: the money engine.
-- _ledger() works out, for one tenant, every bill, every payment, how each
-- payment was applied, and the late interest - from the raw facts, every time.
-- Nothing derived is stored, so editing a bill or a payment never leaves stale numbers.
--
-- Rules:
--  * Interest = unpaid part of a bill x (yearly rate / 365) for each day AFTER the due date
--    (plus any grace days). Simple interest: interest never earns interest.
--  * A payment goes to the OLDEST bill first; inside a bill, to interest first, then rent etc.
--  * Only APPROVED payments count. Money paid before a bill exists is kept as advance credit.
--  * A regular bill starts to count on the first day of its month. "Old dues" (kind 'previous') start to count on
--    their own date ("owed since"), so money paid before that date waits as advance credit until that day.
-- =====================================================================
create or replace function _today() returns date language sql stable set search_path = public as $$
  select (now() at time zone (select timezone from app_settings where id = 1))::date
$$;

create or replace function _inr(p numeric) returns text language sql immutable as $$
  select (case when p < 0 then '-' else '' end) || '₹' ||
         regexp_replace(abs(round(p))::bigint::text, '(\d)(?=(\d\d)+\d$)', '\1,', 'g')
$$;

create or replace function _recalc_bill(p_bill uuid) returns void language sql set search_path = public as $$
  update bills set
    water = round(persons * water_rate, 2),
    electricity = case when new_reading is null then 0
                       else round(greatest(new_reading - prev_reading, 0) * elec_rate, 2) end
  where id = p_bill
$$;

create or replace function _next_receipt(p_date date) returns text language sql set search_path = public as $$
  select (select receipt_prefix from app_settings where id = 1) || '-' || to_char(p_date, 'YYMM') || '-' ||
         lpad(nextval('receipt_seq')::text, 4, '0')
$$;

create or replace function _notify(p_user uuid, p_kind text, p_title text, p_body text,
                                   p_link text default null, p_dedupe text default null)
returns void language sql set search_path = public as $$
  insert into notifications (user_id, kind, title, body, link, dedupe_key)
  values (p_user, p_kind, p_title, p_body, p_link, p_dedupe) on conflict do nothing
$$;

create or replace function _notify_staff(p_kind text, p_title text, p_body text,
                                         p_link text default null, p_dedupe text default null)
returns void language sql set search_path = public as $$
  insert into notifications (user_id, kind, title, body, link, dedupe_key)
  select id, p_kind, p_title, p_body, p_link, p_dedupe from users
  where role in ('owner','admin') and active on conflict do nothing
$$;

-- The words used for a bill wherever text is written: a month name, or "Old dues" for dues entered by hand.
-- (Old dues are kept with the placeholder month 1 January 1900; that date must never be shown to anyone.)
create or replace function _bill_label(p_month date, p_kind text) returns text language sql immutable as $$
  select case when p_kind = 'previous' then 'Old dues' else to_char(p_month, 'FMMonth YYYY') end
$$;

-- "Suresh Kumar, Room 101": how a tenant is named in the Lodging sentences.
create or replace function _who(p_tenancy uuid) returns text language sql stable set search_path = public as $$
  select t.full_name || ', Room ' || r.room_no from tenancies t join rooms r on r.id = t.room_id where t.id = p_tenancy
$$;

-- "Suresh Kumar (Room 101)": the same, as written in payment sentences ("... from Suresh Kumar (Room 101)").
create or replace function _who_p(p_tenancy uuid) returns text language sql stable set search_path = public as $$
  select t.full_name || ' (Room ' || r.room_no || ')' from tenancies t join rooms r on r.id = t.room_id where t.id = p_tenancy
$$;

-- A date as "1 Sep 2026" for the Lodging sentences.
create or replace function _d(p date) returns text language sql immutable as $$ select to_char(p, 'FMDD Mon YYYY') $$;

-- A plain number without useless zeros: 1310.00 -> 1310, 12.50 -> 12.5.
create or replace function _n(p numeric) returns text language sql immutable as $$
  select case when p::text like '%.%' then regexp_replace(p::text, '\.?0+$', '') else p::text end
$$;

-- What changed between two versions of a record: {"before": {changed fields}, "after": {changed fields}}.
create or replace function _diff(p_old jsonb, p_new jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'before', coalesce(jsonb_object_agg(k, p_old->k) filter (where p_old->k is distinct from p_new->k), '{}'::jsonb),
    'after', coalesce(jsonb_object_agg(k, p_new->k) filter (where p_old->k is distinct from p_new->k), '{}'::jsonb))
  from jsonb_object_keys(p_old || p_new) k
$$;

-- Writes one Lodging line. Called inside every function that changes data or decides a request, in the same
-- step as the change itself, so a change and its line always exist together.
--   p_actor   who did it (null = done automatically)        p_action  a short code such as 'payment.approved'
--   p_summary the sentence shown on the Lodging screen       p_tenancy the tenant it is about, if any
--   p_details before / after values                          p_room    room number, when there is no tenant
create or replace function _log(p_actor uuid, p_action text, p_summary text, p_tenancy uuid default null,
                                p_details jsonb default null, p_room text default null)
returns void language plpgsql set search_path = public as $$
declare u users; t tenancies; rn text := p_room; tn text;
begin
  if p_actor is not null then select * into u from users where id = p_actor; end if;
  if p_tenancy is not null then
    select * into t from tenancies where id = p_tenancy;
    if found then tn := t.full_name; rn := coalesce(rn, (select room_no from rooms where id = t.room_id)); end if;
  end if;
  insert into audit_log (actor_id, actor_name, actor_role, action, group_name, summary, room_no, tenant_name, tenancy_id, details)
  values (u.id, u.full_name, u.role, p_action,
    case split_part(p_action, '.', 1)
      when 'payment' then 'payments'
      when 'bill' then 'bills' when 'dues' then 'bills' when 'adjustment' then 'bills' when 'reading' then 'bills' when 'claim' then 'bills'
      when 'settings' then 'settings' when 'team' then 'settings' when 'backup' then 'settings' when 'data' then 'settings'
      else 'tenants' end,
    p_summary, rn, tn, p_tenancy, p_details);
end $$;

create or replace function _ledger(p_tenancy uuid, p_as_of date default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  s app_settings%rowtype;
  asof date;
  daily numeric;
  evs date[];
  d date; prev date;
  n int := 0; m int := 0; i int; j int; k int; nl int;
  b_id uuid[]; b_month date[]; b_start date[]; b_nom date[]; b_due date[];
  b_tot numeric[]; b_waive boolean[]; b_json jsonb[]; b_kind text[];
  b_on boolean[]; prin numeric[]; intr numeric[]; paid_p numeric[]; paid_i numeric[];
  p_id uuid[]; p_date date[]; p_amt numeric[]; p_rcpt text[]; p_meth text[]; p_ref text[]; p_apps jsonb[];
  p_edat timestamptz[]; p_ednote text[];
  l_p int[] := '{}'; l_a numeric[] := '{}';
  take_i numeric; take_p numeric; rem numeric;
  out_bills jsonb; out_pay jsonb; tot jsonb;
begin
  select * into s from app_settings where id = 1;
  asof := coalesce(p_as_of, _today());
  daily := s.interest_rate / 100.0 / 365.0;

  -- Oldest due date first. (The last two sort keys only matter for old dues, which can share a date.)
  select array_agg(x.id order by x.due, x.month, x.created_at, x.id), array_agg(x.month order by x.due, x.month, x.created_at, x.id),
         array_agg(x.start order by x.due, x.month, x.created_at, x.id), array_agg(x.nom order by x.due, x.month, x.created_at, x.id),
         array_agg(x.due order by x.due, x.month, x.created_at, x.id), array_agg(x.tot order by x.due, x.month, x.created_at, x.id),
         array_agg(x.waive order by x.due, x.month, x.created_at, x.id), array_agg(x.js order by x.due, x.month, x.created_at, x.id),
         array_agg(x.kind order by x.due, x.month, x.created_at, x.id)
    into b_id, b_month, b_start, b_nom, b_due, b_tot, b_waive, b_json, b_kind
  from (
    select b.id, b.month, b.kind, b.created_at, b.due_date as nom, b.due_date + s.grace_days as due,
           case when b.kind = 'previous' then b.due_date else b.month end as start,
           b.rent + b.water + b.electricity + coalesce((select sum(a.amount) from bill_adjustments a where a.bill_id = b.id), 0) as tot,
           b.interest_waived as waive,
           jsonb_build_object('id', b.id, 'month', b.month, 'rent', b.rent, 'persons', b.persons,
             'water_rate', b.water_rate, 'water', b.water, 'prev_reading', b.prev_reading,
             'new_reading', b.new_reading, 'elec_rate', b.elec_rate, 'electricity', b.electricity,
             'reading_verified', b.reading_verified, 'photo_id', b.reading_photo, 'reading_at', b.reading_at,
             'due_date', b.due_date, 'interest_waived', b.interest_waived, 'note', b.note,
             'awaiting_reading', b.kind = 'regular' and b.new_reading is null, 'kind', b.kind,
             'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'label', a.label, 'amount', a.amount,
                                        'by', (select full_name from users where id = a.created_by), 'at', a.created_at) order by a.created_at)
                                      from bill_adjustments a where a.bill_id = b.id), '[]'::jsonb)) as js
    from bills b where b.tenancy_id = p_tenancy
  ) x;
  n := coalesce(array_length(b_id, 1), 0);

  select array_agg(y.id order by y.paid_on, y.created_at, y.id), array_agg(y.paid_on order by y.paid_on, y.created_at, y.id),
         array_agg(y.amount order by y.paid_on, y.created_at, y.id), array_agg(y.receipt_no order by y.paid_on, y.created_at, y.id),
         array_agg(y.method order by y.paid_on, y.created_at, y.id), array_agg(y.reference order by y.paid_on, y.created_at, y.id),
         array_agg(y.edited_at order by y.paid_on, y.created_at, y.id), array_agg(y.edit_note order by y.paid_on, y.created_at, y.id)
    into p_id, p_date, p_amt, p_rcpt, p_meth, p_ref, p_edat, p_ednote
  from payments y where y.tenancy_id = p_tenancy and y.status = 'approved' and y.paid_on <= asof;
  m := coalesce(array_length(p_id, 1), 0);

  if n > 0 then
    b_on := array_fill(false, array[n]);
    prin := array_fill(0::numeric, array[n]); intr := array_fill(0::numeric, array[n]);
    paid_p := array_fill(0::numeric, array[n]); paid_i := array_fill(0::numeric, array[n]);
  end if;
  if m > 0 then p_apps := array_fill(null::jsonb, array[m]); end if;

  select array_agg(distinct q.x order by q.x) into evs from (
    select unnest(b_start) as x union select unnest(p_date) union select asof) q
  where q.x <= asof;

  foreach d in array evs loop
    if prev is not null and d > prev then            -- interest for the days in (prev, d]
      for i in 1..n loop
        if b_on[i] and not b_waive[i] and prin[i] > 0 and d > b_due[i] then
          intr[i] := intr[i] + prin[i] * daily * (d - greatest(prev, b_due[i]));
        end if;
      end loop;
    end if;
    for i in 1..n loop                                -- bills that start today
      if not b_on[i] and b_start[i] = d then
        b_on[i] := true;
        prin[i] := greatest(b_tot[i], 0);
        if b_tot[i] < 0 then l_p := l_p || 0; l_a := l_a || (-b_tot[i]); end if;
      end if;
    end loop;
    for j in 1..m loop                                -- payments made today
      if p_date[j] = d then l_p := l_p || j; l_a := l_a || p_amt[j]; end if;
    end loop;
    nl := coalesce(array_length(l_a, 1), 0);          -- spend money (and credit) on the oldest bills first
    for k in 1..nl loop
      rem := l_a[k];
      for i in 1..n loop
        exit when rem <= 0;
        continue when not b_on[i];
        take_i := least(rem, round(intr[i], 2));
        take_p := least(rem - take_i, prin[i]);
        if take_i > 0 or take_p > 0 then
          intr[i] := intr[i] - take_i; prin[i] := prin[i] - take_p;
          paid_i[i] := paid_i[i] + take_i; paid_p[i] := paid_p[i] + take_p;
          rem := rem - take_i - take_p;
          if l_p[k] > 0 then
            p_apps[l_p[k]] := coalesce(p_apps[l_p[k]], '[]'::jsonb) ||
              jsonb_build_object('bill_id', b_id[i], 'month', b_month[i], 'kind', b_kind[i], 'interest', take_i, 'principal', take_p);
          end if;
        end if;
      end loop;
      l_a[k] := rem;
    end loop;
    prev := d;
  end loop;

  select coalesce(jsonb_agg(b_json[g.i] || jsonb_build_object(
      'total', b_tot[g.i],
      'late_after', b_due[g.i],
      'principal_paid', case when b_on[g.i] then greatest(b_tot[g.i], 0) - prin[g.i] else 0 end,
      'interest_paid', paid_i[g.i],
      'interest_charged', paid_i[g.i] + round(intr[g.i], 2),
      'principal_left', prin[g.i], 'interest_left', round(intr[g.i], 2),
      'outstanding', prin[g.i] + round(intr[g.i], 2),
      'days_late', case when b_on[g.i] and prin[g.i] > 0 and asof > b_nom[g.i] then asof - b_nom[g.i] else 0 end,
      'is_overdue', b_on[g.i] and prin[g.i] > 0 and asof > b_nom[g.i],
      'status', case when not b_on[g.i] then 'upcoming'
                     when prin[g.i] + round(intr[g.i], 2) = 0 then 'paid'
                     when paid_p[g.i] + paid_i[g.i] > 0 then 'partial' else 'unpaid' end
    ) order by g.i), '[]'::jsonb)
  into out_bills from generate_series(1, n) as g(i);

  select coalesce(jsonb_agg(jsonb_build_object('id', p_id[g.i], 'receipt_no', p_rcpt[g.i], 'amount', p_amt[g.i],
      'paid_on', p_date[g.i], 'method', p_meth[g.i], 'reference', p_ref[g.i],
      'edited_at', p_edat[g.i], 'edit_note', p_ednote[g.i],
      'applied', coalesce(p_apps[g.i], '[]'::jsonb),
      'credit_left', coalesce((select sum(l_a[z]) from generate_series(1, coalesce(array_length(l_a,1),0)) z where l_p[z] = g.i), 0)
    ) order by g.i desc), '[]'::jsonb)
  into out_pay from generate_series(1, m) as g(i);

  select jsonb_build_object(
    'as_of', asof,
    'billed', coalesce(sum(b_tot[g.i]) filter (where b_on[g.i]), 0),
    'paid', coalesce((select sum(v) from unnest(p_amt) v), 0),
    'principal_due', coalesce(sum(prin[g.i]), 0),
    'interest_due', coalesce(sum(round(intr[g.i], 2)), 0),
    'interest_charged', coalesce(sum(paid_i[g.i] + round(intr[g.i], 2)), 0),
    'outstanding', coalesce(sum(prin[g.i] + round(intr[g.i], 2)), 0),
    'credit', coalesce((select sum(v) from unnest(l_a) v where v > 0), 0),
    'overdue_amount', coalesce(sum(prin[g.i] + round(intr[g.i], 2)) filter (where b_on[g.i] and prin[g.i] > 0 and asof > b_nom[g.i]), 0),
    'overdue_bills', coalesce(count(*) filter (where b_on[g.i] and prin[g.i] > 0 and asof > b_nom[g.i]), 0),
    'max_days_late', coalesce(max(asof - b_nom[g.i]) filter (where b_on[g.i] and prin[g.i] > 0 and asof > b_nom[g.i]), 0),
    'next_due_date', min(b_nom[g.i]) filter (where b_on[g.i] and prin[g.i] + round(intr[g.i], 2) > 0)
  ) into tot from generate_series(1, n) as g(i);

  return jsonb_build_object('totals', tot, 'bills', out_bills, 'payments', out_pay);
end $$;
-- =====================================================================
-- PART 3: sign-in, sessions and user management.
-- Passwords are stored only as bcrypt hashes. A sign-in gives a random token;
-- only its hash is kept. Every function below receives that token and checks it.
-- =====================================================================
create or replace function _hash(p_password text) returns text language plpgsql set search_path = public, extensions as $$
begin
  if p_password is null or length(p_password) < 6 then raise exception 'Password must be at least 6 characters'; end if;
  return extensions.crypt(p_password, extensions.gen_salt('bf', 10));
end $$;

create or replace function _clean_login(p text) returns text language plpgsql immutable as $$
declare v text := lower(trim(coalesce(p, '')));
begin
  if v !~ '^[a-z0-9._@+-]{2,40}$' then
    raise exception 'ID must be 2-40 letters, numbers or . _ - @ (no spaces)';
  end if;
  return v;
end $$;

create or replace function _user_json(u users) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', u.id, 'login_id', u.login_id, 'full_name', u.full_name,
                            'role', u.role, 'email', u.email, 'phone', u.phone)
$$;

create or replace function _auth(p_token text, p_roles text[] default null)
returns users language plpgsql security definer set search_path = public, extensions as $$
declare u users; s sessions;
begin
  select * into s from sessions where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and expires_at > now();
  if not found then raise exception 'SESSION_EXPIRED'; end if;
  select * into u from users where id = s.user_id and active;
  if not found then raise exception 'SESSION_EXPIRED'; end if;
  if p_roles is not null and not (u.role = any (p_roles)) then raise exception 'You are not allowed to do this'; end if;
  if s.last_seen < now() - interval '1 hour' then
    update sessions set last_seen = now(), expires_at = now() + interval '60 days' where token_hash = s.token_hash;
  end if;
  return u;
end $$;

create or replace function _staff(p_token text) returns users language sql security definer set search_path = public, extensions as $$
  select * from _auth(p_token, array['owner','admin']) $$;
create or replace function _owner(p_token text) returns users language sql security definer set search_path = public, extensions as $$
  select * from _auth(p_token, array['owner']) $$;

-- Run once from the SQL editor (see the guide). Not callable from the app.
create or replace function setup_owner(p_login text, p_name text, p_email text, p_password text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from users where role = 'owner') then raise exception 'An owner already exists'; end if;
  insert into users (login_id, password_hash, role, full_name, email)
  values (_clean_login(p_login), _hash(p_password), 'owner', trim(p_name), nullif(trim(p_email), ''));
  return 'Owner created. Sign in with ID: ' || _clean_login(p_login);
end $$;

-- Forgot the owner password? In the Supabase SQL Editor run:   select reset_owner_password('a-new-password');
-- (The internet cannot call this: it is not in the list of functions the app may use.)
create or replace function reset_owner_password(p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare o users;
begin
  select * into o from users where role = 'owner' order by created_at limit 1;
  if not found then raise exception 'There is no owner yet. Use setup_owner first.'; end if;
  update users set password_hash = _hash(p_password), active = true where id = o.id;
  delete from sessions where user_id = o.id;
  delete from login_attempts where login_id = lower(o.login_id);
  return 'Password changed. Sign in with ID: ' || o.login_id;
end $$;

-- Starting fresh after you have tried the app with test data (guide, "Testing first, then starting fresh").
-- Deletes ALL rooms, tenants (and their logins), bills, payments, requests, documents, alerts and the Lodging lines.
-- Keeps your owner login, any other master-access people, and your settings.
-- Only the Supabase SQL Editor can run this; the internet cannot.
create or replace function wipe_everything_except_owner(p_confirm text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_confirm is distinct from 'yes, delete all rooms, tenants and payments' then
    raise exception 'Nothing was deleted. To really delete everything, type the exact confirmation sentence shown in the guide.';
  end if;
  perform set_config('rb.wipe', 'on', true);                        -- lets this one function clear the Lodging lines
  delete from audit_log where true;
  delete from tenant_documents where true;
  delete from payments where true;
  delete from deduction_claims where true;
  delete from tickets where true;
  delete from bill_adjustments where true;
  delete from bills where true;
  delete from tenancies where true;
  delete from rooms where true;
  delete from attachments where true;
  delete from notifications where true;
  delete from users where role = 'tenant';                       -- also removes their sessions and phone alerts
  delete from login_attempts where login_id not in (select lower(login_id) from users);
  perform setval('receipt_seq', 1, false);
  perform set_config('rb.wipe', 'off', true);
  perform _log(null, 'data.wiped', 'All test data was deleted');
  return 'Done. All rooms, tenants, bills, payments and requests were deleted. Your login and your settings were kept.';
end $$;

create or replace function public_info() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('building_name', (select building_name from app_settings where id = 1),
                            'has_owner', exists (select 1 from users where role = 'owner'),
                            'schema_version', (select schema_version from app_settings where id = 1))
$$;

create or replace function login(p_login text, p_password text, p_device text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare u users; la login_attempts; tok text; lid text := lower(trim(coalesce(p_login, '')));
begin
  select * into la from login_attempts where login_id = lid;
  if found and la.locked_until is not null and la.locked_until > now() then
    return jsonb_build_object('error', 'Too many wrong attempts. Please wait 10 minutes and try again.');
  end if;
  select * into u from users where lower(login_id) = lid and active;
  if not found or u.password_hash <> extensions.crypt(coalesce(p_password, ''), u.password_hash) then
    if found then
      insert into login_attempts (login_id, fails) values (lid, 1)
      on conflict (login_id) do update set fails = login_attempts.fails + 1, updated_at = now(),
        locked_until = case when login_attempts.fails + 1 >= 5 then now() + interval '10 minutes' else null end;
    end if;
    return jsonb_build_object('error', 'Wrong ID or password');   -- returned, not raised: raising would undo the attempt counter
  end if;
  delete from login_attempts where login_id = lid;
  tok := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  insert into sessions (token_hash, user_id, device, expires_at)
  values (encode(extensions.digest(tok, 'sha256'), 'hex'), u.id, left(p_device, 200), now() + interval '60 days');
  update users set last_login_at = now() where id = u.id;
  delete from sessions where user_id = u.id and expires_at < now();
  return jsonb_build_object('token', tok, 'user', _user_json(u));
end $$;

create or replace function logout(p_token text) returns void language sql security definer set search_path = public, extensions as $$
  delete from sessions where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') $$;

create or replace function _settings_json() returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('building_name', building_name, 'water_rate', water_rate, 'electricity_rate', electricity_rate,
    'interest_rate', interest_rate, 'grace_days', grace_days, 'bill_day', bill_day, 'reminder_days', to_jsonb(reminder_days),
    'timezone', timezone, 'upi_id', upi_id, 'app_url', app_url, 'schema_version', schema_version) from app_settings where id = 1 $$;

create or replace function _inbox_count() returns int language sql stable set search_path = public as $$
  select (select count(*) from payments where status = 'pending')::int
       + (select count(*) from deduction_claims where status = 'pending')::int
       + (select count(*) from bills b join tenancies t on t.id = b.tenancy_id
            where b.reading_by is not null and not b.reading_verified and t.status = 'active')::int
       + (select count(*) from tickets where status in ('open','seen','in_progress'))::int $$;

create or replace function me(p_token text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies; r jsonb;
begin
  u := _auth(p_token);
  r := jsonb_build_object('user', _user_json(u), 'settings', _settings_json(),
         'unread', (select count(*) from notifications where user_id = u.id and read_at is null));
  if u.role = 'tenant' then
    select * into t from tenancies where user_id = u.id order by (status = 'active') desc, start_date desc limit 1;
    if found then
      r := r || jsonb_build_object('tenancy_id', t.id, 'room_no', (select room_no from rooms where id = t.room_id), 'tenancy_status', t.status);
    end if;
  else
    r := r || jsonb_build_object('inbox', _inbox_count());
  end if;
  return r;
end $$;

create or replace function change_password(p_token text, p_old text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _auth(p_token);
  if u.password_hash <> extensions.crypt(coalesce(p_old, ''), u.password_hash) then raise exception 'Your current password is wrong'; end if;
  update users set password_hash = _hash(p_new) where id = u.id;
  delete from sessions where user_id = u.id and token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex');
end $$;

create or replace function update_profile(p_token text, p_name text, p_email text, p_phone text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _auth(p_token);
  update users set full_name = coalesce(nullif(trim(p_name), ''), full_name), email = nullif(trim(p_email), ''), phone = nullif(trim(p_phone), '') where id = u.id;
  if u.role = 'tenant' then
    update tenancies set email = nullif(trim(p_email), ''), phone = nullif(trim(p_phone), '') where user_id = u.id and status = 'active';
  end if;
end $$;

-- ---------- settings and staff (master access) ----------
create or replace function update_settings(p_token text, p_fields jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; o app_settings; n app_settings; ch text[] := '{}';
begin
  u := _staff(p_token);
  select * into o from app_settings where id = 1;
  if p_fields ? 'app_url' and nullif(trim(p_fields->>'app_url'), '') is not null
     and trim(p_fields->>'app_url') !~* '^https?://[^[:space:]<>"'']+$' then
    raise exception 'The app address must start with https:// and have no spaces';
  end if;
  update app_settings set
    building_name = coalesce(nullif(trim(p_fields->>'building_name'), ''), building_name),
    water_rate = coalesce((p_fields->>'water_rate')::numeric, water_rate),
    electricity_rate = coalesce((p_fields->>'electricity_rate')::numeric, electricity_rate),
    interest_rate = coalesce((p_fields->>'interest_rate')::numeric, interest_rate),
    grace_days = coalesce((p_fields->>'grace_days')::int, grace_days),
    bill_day = coalesce((p_fields->>'bill_day')::int, bill_day),
    reminder_days = coalesce((select array_agg(v::int order by v::int desc) from jsonb_array_elements_text(p_fields->'reminder_days') v), reminder_days),
    upi_id = case when p_fields ? 'upi_id' then nullif(trim(p_fields->>'upi_id'), '') else upi_id end,
    app_url = case when p_fields ? 'app_url' then nullif(trim(p_fields->>'app_url'), '') else app_url end,
    updated_at = now()
  where id = 1 returning * into n;
  if n.building_name is distinct from o.building_name then ch := ch || ('building name ' || o.building_name || ' to ' || n.building_name); end if;
  if n.water_rate is distinct from o.water_rate then ch := ch || ('water per person ' || _inr(o.water_rate) || ' to ' || _inr(n.water_rate)); end if;
  if n.electricity_rate is distinct from o.electricity_rate then ch := ch || ('electricity per unit ' || _inr(o.electricity_rate) || ' to ' || _inr(n.electricity_rate)); end if;
  if n.interest_rate is distinct from o.interest_rate then ch := ch || ('late interest ' || _n(o.interest_rate) || '% to ' || _n(n.interest_rate) || '%'); end if;
  if n.grace_days is distinct from o.grace_days then ch := ch || ('grace days ' || o.grace_days || ' to ' || n.grace_days); end if;
  if n.bill_day is distinct from o.bill_day then ch := ch || ('bill day ' || o.bill_day || ' to ' || n.bill_day); end if;
  if n.reminder_days is distinct from o.reminder_days then ch := ch || ('reminder days ' || array_to_string(o.reminder_days, ', ') || ' to ' || array_to_string(n.reminder_days, ', ')); end if;
  if n.upi_id is distinct from o.upi_id then ch := ch || ('UPI ID ' || coalesce(o.upi_id, 'none') || ' to ' || coalesce(n.upi_id, 'none')); end if;
  if n.app_url is distinct from o.app_url then ch := ch || ('app address ' || coalesce(o.app_url, 'none') || ' to ' || coalesce(n.app_url, 'none')); end if;
  if coalesce(array_length(ch, 1), 0) > 0 then
    perform _log(u.id, 'settings.changed', 'Changed settings: ' || array_to_string(ch, '; '), null, _diff(to_jsonb(o) - 'updated_at', to_jsonb(n) - 'updated_at'));
  end if;
  return _settings_json();
end $$;

create or replace function staff_users(p_token text) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _owner(p_token);
  return coalesce((select jsonb_agg(_user_json(x) || jsonb_build_object('active', x.active, 'last_login_at', x.last_login_at) order by (x.role = 'owner') desc, x.full_name)
                   from users x where x.role in ('owner','admin')), '[]'::jsonb);
end $$;

create or replace function add_admin(p_token text, p_login text, p_name text, p_email text, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; nu users;
begin
  u := _owner(p_token);
  if coalesce(trim(p_name), '') = '' then raise exception 'Please enter a name'; end if;
  begin
    insert into users (login_id, password_hash, role, full_name, email)
    values (_clean_login(p_login), _hash(p_password), 'admin', trim(p_name), nullif(trim(p_email), '')) returning * into nu;
  exception when unique_violation then raise exception 'That ID is already taken';
  end;
  perform _log(u.id, 'team.added', 'Gave master access to ' || nu.full_name || ' (login ' || nu.login_id || ')', null, jsonb_build_object('user_id', nu.id, 'login_id', nu.login_id));
  return _user_json(nu);
end $$;

create or replace function set_user_active(p_token text, p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; target users; tid uuid;
begin
  u := _staff(p_token);
  select * into target from users where id = p_user;
  if not found then raise exception 'User not found'; end if;
  if target.role = 'owner' then raise exception 'The owner account cannot be switched off'; end if;
  if target.role = 'admin' and u.role <> 'owner' then raise exception 'Only the owner can change an admin'; end if;
  update users set active = p_active where id = p_user;
  if not p_active then delete from sessions where user_id = p_user; end if;
  if target.active is distinct from p_active then
    if target.role = 'tenant' then
      select id into tid from tenancies where user_id = target.id order by (status = 'active') desc, start_date desc limit 1;
      perform _log(u.id, case when p_active then 'tenant.login_switched_on' else 'tenant.login_switched_off' end,
                   'Switched ' || case when p_active then 'on' else 'off' end || ' the login of ' || coalesce(_who(tid), target.full_name) || ' (' || target.login_id || ')',
                   tid, jsonb_build_object('user_id', target.id, 'login_id', target.login_id));
    else
      perform _log(u.id, case when p_active then 'team.switched_on' else 'team.switched_off' end,
                   'Switched ' || case when p_active then 'on' else 'off' end || ' master access of ' || target.full_name || ' (login ' || target.login_id || ')',
                   null, jsonb_build_object('user_id', target.id, 'login_id', target.login_id));
    end if;
  end if;
end $$;

create or replace function reset_password(p_token text, p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; target users; tid uuid;
begin
  u := _staff(p_token);
  select * into target from users where id = p_user;
  if not found then raise exception 'User not found'; end if;
  if target.role = 'owner' and target.id <> u.id then raise exception 'Only the owner can change the owner password'; end if;
  if target.role = 'admin' and u.role <> 'owner' then raise exception 'Only the owner can change an admin password'; end if;
  update users set password_hash = _hash(p_password) where id = p_user;
  delete from sessions where user_id = p_user;
  -- The line says THAT a password was changed and whose. The password itself is never written anywhere.
  if target.role = 'tenant' then
    select id into tid from tenancies where user_id = target.id order by (status = 'active') desc, start_date desc limit 1;
    perform _log(u.id, 'tenant.password_reset', 'Set a new password for ' || coalesce(_who(tid), target.full_name) || ' (login ' || target.login_id || ')',
                 tid, jsonb_build_object('user_id', target.id, 'login_id', target.login_id));
  else
    perform _log(u.id, 'team.password_reset', 'Set a new password for ' || target.full_name || ' (login ' || target.login_id || ')',
                 null, jsonb_build_object('user_id', target.id, 'login_id', target.login_id));
  end if;
end $$;

create or replace function create_tenant_login(p_token text, p_tenancy uuid, p_login text, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies; nu users;
begin
  u := _staff(p_token);
  select * into t from tenancies where id = p_tenancy;
  if not found then raise exception 'Tenant not found'; end if;
  if t.user_id is not null then raise exception 'This tenant already has a login. Use "Reset password" instead.'; end if;
  begin
    insert into users (login_id, password_hash, role, full_name, email, phone)
    values (_clean_login(p_login), _hash(p_password), 'tenant', t.full_name, t.email, t.phone) returning * into nu;
  exception when unique_violation then raise exception 'That ID is already taken';
  end;
  update tenancies set user_id = nu.id where id = p_tenancy;
  perform _log(u.id, 'tenant.login_created', 'Made a login for ' || _who(p_tenancy) || ' (login ' || nu.login_id || ')', p_tenancy, jsonb_build_object('user_id', nu.id, 'login_id', nu.login_id));
  return _user_json(nu);
end $$;
-- =====================================================================
-- PART 4: rooms, tenants and the screens built from them (owner/admin only,
-- except _tenancy_view which the tenant screen also uses for its OWN record).
-- =====================================================================
-- A ledger as a tenant may see it: the same numbers, without the names of the masters who made each change.
create or replace function _ledger_for_tenant(p_ledger jsonb) returns jsonb language sql immutable as $$
  select jsonb_set(p_ledger, '{bills}', coalesce((
    select jsonb_agg(jsonb_set(b, '{adjustments}', coalesce((select jsonb_agg(a - 'by' order by o2) from jsonb_array_elements(b->'adjustments') with ordinality x(a, o2)), '[]'::jsonb)) order by o)
    from jsonb_array_elements(p_ledger->'bills') with ordinality y(b, o)), '[]'::jsonb))
$$;

create or replace function _tenancy_view(p_tenancy uuid, p_staff boolean) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare t tenancies; r rooms; tj jsonb; rem record;
begin
  select * into t from tenancies where id = p_tenancy;
  if not found then return null; end if;
  select * into r from rooms where id = t.room_id;
  tj := jsonb_build_object('id', t.id, 'room_id', t.room_id, 'room_no', r.room_no, 'full_name', t.full_name, 'phone', t.phone,
          'email', t.email, 'persons', t.persons, 'rent', t.rent, 'due_day', t.due_day, 'deposit', t.deposit,
          'start_date', t.start_date, 'end_date', t.end_date, 'status', t.status, 'emergency_contact', t.emergency_contact,
          'login_id', (select login_id from users where id = t.user_id), 'has_login', t.user_id is not null);
  if p_staff then
    -- the last time a master reminded this tenant (shown as "Reminded 2 days ago (WhatsApp)")
    select a.at, split_part(a.action, '.', 2) as channel into rem from audit_log a where a.tenancy_id = t.id and a.action like 'reminder.%' order by a.at desc, a.id desc limit 1;
    tj := tj || jsonb_build_object('opening_reading', t.opening_reading, 'id_proof', t.id_proof, 'notes', t.notes, 'user_id', t.user_id,
            'last_reminder', case when rem.at is null then null else jsonb_build_object('at', rem.at, 'channel', rem.channel) end,
            'documents', (select count(*) from tenant_documents d where d.tenancy_id = t.id));
  end if;
  return jsonb_build_object(
    'tenancy', tj,
    'ledger', case when p_staff then _ledger(t.id) else _ledger_for_tenant(_ledger(t.id)) end,
    'other_payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'paid_on', p.paid_on,
        'method', p.method, 'reference', p.reference, 'note', p.note, 'status', p.status, 'by_tenant', p.by_tenant,
        'decision_note', p.decision_note, 'proof_id', p.proof, 'created_at', p.created_at) order by p.created_at desc)
        from payments p where p.tenancy_id = t.id and p.status <> 'approved'), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'description', c.description, 'requested', c.requested,
        'approved', c.approved, 'status', c.status, 'bill_id', c.bill_id, 'decision_note', c.decision_note,
        'proof_id', c.proof, 'created_at', c.created_at) order by c.created_at desc)
        from deduction_claims c where c.tenancy_id = t.id), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'kind', k.kind, 'title', k.title, 'details', k.details,
        'status', k.status, 'owner_note', k.owner_note, 'photo_id', k.photo, 'created_at', k.created_at, 'updated_at', k.updated_at)
        order by k.created_at desc) from tickets k where k.tenancy_id = t.id), '[]'::jsonb));
end $$;

create or replace function rooms_overview(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; r record; led jsonb; tot jsonb; st text; rooms_out jsonb := '[]'::jsonb;
  today date := _today(); mstart date := date_trunc('month', _today())::date;
  sum_out numeric := 0; sum_over numeric := 0; n_over int := 0; n_empty int := 0; n_paid int := 0; n_due int := 0;
begin
  u := _staff(p_token);
  for r in
    select rm.id as room_id, rm.room_no, rm.floor, rm.default_rent, t.id as tid, t.full_name, t.phone, t.persons, t.rent, t.due_day
    from rooms rm left join tenancies t on t.room_id = rm.id and t.status = 'active'
    where rm.active order by length(rm.room_no), rm.room_no
  loop
    if r.tid is null then
      n_empty := n_empty + 1;
      rooms_out := rooms_out || jsonb_build_object('room_id', r.room_id, 'room_no', r.room_no, 'floor', r.floor, 'default_rent', r.default_rent, 'status', 'empty');
      continue;
    end if;
    led := _ledger(r.tid); tot := led->'totals';
    st := case when (tot->>'overdue_bills')::int > 0 then 'overdue'
               when (tot->>'outstanding')::numeric > 0 then 'due'
               -- "No bill yet" = no MONTHLY bill (old dues alone do not count as a bill)
               when not exists (select 1 from jsonb_array_elements(led->'bills') b where b->>'kind' = 'regular') then 'nobill'
               else 'paid' end;
    if st = 'overdue' then n_over := n_over + 1; elsif st = 'due' then n_due := n_due + 1; elsif st = 'paid' then n_paid := n_paid + 1; end if;
    sum_out := sum_out + (tot->>'outstanding')::numeric; sum_over := sum_over + (tot->>'overdue_amount')::numeric;
    rooms_out := rooms_out || jsonb_build_object(
      'room_id', r.room_id, 'room_no', r.room_no, 'floor', r.floor, 'tenancy_id', r.tid, 'tenant', r.full_name, 'phone', r.phone,
      'persons', r.persons, 'rent', r.rent, 'status', st,
      'outstanding', tot->'outstanding', 'interest_due', tot->'interest_due', 'overdue_amount', tot->'overdue_amount',
      'max_days_late', tot->'max_days_late', 'credit', tot->'credit', 'next_due_date', tot->'next_due_date',
      'awaiting_reading', exists (select 1 from jsonb_array_elements(led->'bills') b where (b->>'awaiting_reading')::boolean),
      'pending_items',
        (select count(*) from payments where tenancy_id = r.tid and status = 'pending')
      + (select count(*) from deduction_claims where tenancy_id = r.tid and status = 'pending')
      + (select count(*) from tickets where tenancy_id = r.tid and status in ('open','seen','in_progress'))
      + (select count(*) from bills where tenancy_id = r.tid and reading_by is not null and not reading_verified));
  end loop;
  return jsonb_build_object('rooms', rooms_out, 'inbox', _inbox_count(),
    'summary', jsonb_build_object('outstanding', sum_out, 'overdue_amount', sum_over, 'overdue_rooms', n_over, 'due_rooms', n_due,
      'paid_rooms', n_paid, 'empty_rooms', n_empty,
      'collected_this_month', coalesce((select sum(amount) from payments where status = 'approved' and paid_on >= mstart and paid_on <= today), 0)));
end $$;

create or replace function room_detail(p_token text, p_room uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; r rooms; tid uuid;
begin
  u := _staff(p_token);
  select * into r from rooms where id = p_room;
  if not found then raise exception 'Room not found'; end if;
  select id into tid from tenancies where room_id = p_room and status = 'active';
  return jsonb_build_object(
    'room', to_jsonb(r),
    'current', case when tid is null then null else _tenancy_view(tid, true) end,
    'past', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'full_name', t.full_name, 'start_date', t.start_date,
              'end_date', t.end_date, 'outstanding', (_ledger(t.id)->'totals'->>'outstanding')::numeric) order by t.start_date desc)
            from tenancies t where t.room_id = p_room and t.status = 'ended'), '[]'::jsonb));
end $$;

create or replace function tenancy_detail(p_token text, p_tenancy uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _staff(p_token);
  return _tenancy_view(p_tenancy, true);
end $$;

create or replace function save_room(p_token text, p_id uuid, p_room_no text, p_floor text, p_default_rent numeric, p_notes text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare u users; rid uuid; o rooms; n rooms; ch text[] := '{}';
begin
  u := _staff(p_token);
  if coalesce(trim(p_room_no), '') = '' then raise exception 'Please enter a room number'; end if;
  if p_id is not null then select * into o from rooms where id = p_id; end if;
  begin
    if p_id is null then
      insert into rooms (room_no, floor, default_rent, notes) values (trim(p_room_no), nullif(trim(p_floor), ''), coalesce(p_default_rent, 0), nullif(trim(p_notes), '')) returning * into n;
    else
      update rooms set room_no = trim(p_room_no), floor = nullif(trim(p_floor), ''), default_rent = coalesce(p_default_rent, default_rent), notes = nullif(trim(p_notes), '') where id = p_id returning * into n;
    end if;
  exception when unique_violation then raise exception 'A room with this number already exists';
  end;
  rid := n.id;
  if p_id is null then
    perform _log(u.id, 'room.added', 'Added Room ' || n.room_no || coalesce(' (floor ' || n.floor || ')', '') || ', usual rent ' || _inr(n.default_rent),
                 null, jsonb_build_object('room_id', n.id, 'room_no', n.room_no, 'floor', n.floor, 'default_rent', n.default_rent), n.room_no);
  elsif rid is not null then
    if n.room_no is distinct from o.room_no then ch := ch || ('number ' || o.room_no || ' to ' || n.room_no); end if;
    if n.floor is distinct from o.floor then ch := ch || ('floor ' || coalesce(o.floor, 'none') || ' to ' || coalesce(n.floor, 'none')); end if;
    if n.default_rent is distinct from o.default_rent then ch := ch || ('usual rent ' || _inr(o.default_rent) || ' to ' || _inr(n.default_rent)); end if;
    if n.notes is distinct from o.notes then ch := ch || 'notes changed'::text; end if;
    if coalesce(array_length(ch, 1), 0) > 0 then
      perform _log(u.id, 'room.edited', 'Changed Room ' || o.room_no || ': ' || array_to_string(ch, '; '), null,
                   jsonb_build_object('room_id', n.id) || _diff(to_jsonb(o), to_jsonb(n)), n.room_no);
    end if;
  end if;
  return rid;
end $$;

-- A new tenant. p_fields may carry "old_dues": a list of up to 12 rows {amount, note, since} for money the tenant
-- already owes. The tenant, the login and every old-dues row are saved together: if one is wrong, nothing is saved.
create or replace function move_in(p_token text, p_room uuid, p_fields jsonb, p_login text default null, p_password text default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare u users; tid uuid; t tenancies; od jsonb := p_fields->'old_dues'; e jsonb;
begin
  u := _staff(p_token);
  if exists (select 1 from tenancies where room_id = p_room and status = 'active') then raise exception 'This room already has a tenant. Move them out first.'; end if;
  if coalesce(trim(p_fields->>'full_name'), '') = '' then raise exception 'Please enter the tenant name'; end if;
  if od is not null and jsonb_typeof(od) not in ('array', 'null') then raise exception 'The old dues were not sent as a list. Please try again.'; end if;
  if jsonb_typeof(od) = 'array' and jsonb_array_length(od) > 12 then raise exception 'At most 12 old dues rows can be added here. Add the rest from the room page.'; end if;
  insert into tenancies (room_id, full_name, phone, email, persons, rent, due_day, deposit, start_date, opening_reading, emergency_contact, id_proof, notes)
  values (p_room, trim(p_fields->>'full_name'), nullif(trim(p_fields->>'phone'), ''), nullif(trim(p_fields->>'email'), ''),
          coalesce((p_fields->>'persons')::int, 1), coalesce((p_fields->>'rent')::numeric, (select default_rent from rooms where id = p_room)),
          coalesce((p_fields->>'due_day')::int, 5), coalesce((p_fields->>'deposit')::numeric, 0),
          coalesce((p_fields->>'start_date')::date, _today()), coalesce((p_fields->>'opening_reading')::numeric, 0),
          nullif(trim(p_fields->>'emergency_contact'), ''), nullif(trim(p_fields->>'id_proof'), ''), nullif(trim(p_fields->>'notes'), ''))
  returning * into t;
  tid := t.id;
  perform _log(u.id, 'tenant.moved_in', 'Moved in ' || _who(tid) || ': rent ' || _inr(t.rent) || ', ' || t.persons || case when t.persons = 1 then ' person' else ' people' end ||
               ', from ' || _d(t.start_date) || case when t.deposit > 0 then ', deposit ' || _inr(t.deposit) else '' end,
               tid, jsonb_build_object('tenancy', to_jsonb(t) - 'id' - 'room_id' - 'user_id' - 'created_at'));
  if coalesce(trim(p_login), '') <> '' then perform create_tenant_login(p_token, tid, p_login, p_password); end if;
  if jsonb_typeof(od) = 'array' then
    for e in select x from jsonb_array_elements(od) x loop
      perform _add_old_dues(u.id, tid, nullif(trim(e->>'amount'), '')::numeric, e->>'note', nullif(trim(e->>'since'), '')::date);
    end loop;
  end if;
  return tid;
end $$;

create or replace function save_tenancy(p_token text, p_id uuid, p_fields jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; o tenancies; t tenancies; ch text[] := '{}';
begin
  u := _staff(p_token);
  select * into o from tenancies where id = p_id for update;
  update tenancies set
    full_name = coalesce(nullif(trim(p_fields->>'full_name'), ''), full_name),
    phone = case when p_fields ? 'phone' then nullif(trim(p_fields->>'phone'), '') else phone end,
    email = case when p_fields ? 'email' then nullif(trim(p_fields->>'email'), '') else email end,
    persons = coalesce((p_fields->>'persons')::int, persons),
    rent = coalesce((p_fields->>'rent')::numeric, rent),
    due_day = coalesce((p_fields->>'due_day')::int, due_day),
    deposit = coalesce((p_fields->>'deposit')::numeric, deposit),
    start_date = coalesce((p_fields->>'start_date')::date, start_date),
    opening_reading = coalesce((p_fields->>'opening_reading')::numeric, opening_reading),
    emergency_contact = case when p_fields ? 'emergency_contact' then nullif(trim(p_fields->>'emergency_contact'), '') else emergency_contact end,
    id_proof = case when p_fields ? 'id_proof' then nullif(trim(p_fields->>'id_proof'), '') else id_proof end,
    notes = case when p_fields ? 'notes' then nullif(trim(p_fields->>'notes'), '') else notes end
  where id = p_id returning * into t;
  if not found then raise exception 'Tenant not found'; end if;
  if t.user_id is not null then
    update users set full_name = t.full_name, email = t.email, phone = t.phone where id = t.user_id;
  end if;
  if t.full_name is distinct from o.full_name then ch := ch || ('name ' || o.full_name || ' to ' || t.full_name); end if;
  if t.rent is distinct from o.rent then ch := ch || ('monthly rent ' || _inr(o.rent) || ' to ' || _inr(t.rent)); end if;
  if t.persons is distinct from o.persons then ch := ch || ('people ' || o.persons || ' to ' || t.persons); end if;
  if t.due_day is distinct from o.due_day then ch := ch || ('due day ' || o.due_day || ' to ' || t.due_day); end if;
  if t.deposit is distinct from o.deposit then ch := ch || ('deposit ' || _inr(o.deposit) || ' to ' || _inr(t.deposit)); end if;
  if t.start_date is distinct from o.start_date then ch := ch || ('start date ' || _d(o.start_date) || ' to ' || _d(t.start_date)); end if;
  if t.opening_reading is distinct from o.opening_reading then ch := ch || ('opening meter reading ' || _n(o.opening_reading) || ' to ' || _n(t.opening_reading)); end if;
  if t.phone is distinct from o.phone then ch := ch || ('phone ' || coalesce(o.phone, 'none') || ' to ' || coalesce(t.phone, 'none')); end if;
  if t.email is distinct from o.email then ch := ch || ('email ' || coalesce(o.email, 'none') || ' to ' || coalesce(t.email, 'none')); end if;
  if t.emergency_contact is distinct from o.emergency_contact then ch := ch || 'emergency contact changed'::text; end if;
  if t.id_proof is distinct from o.id_proof then ch := ch || 'ID proof note changed'::text; end if;
  if t.notes is distinct from o.notes then ch := ch || 'notes changed'::text; end if;
  if coalesce(array_length(ch, 1), 0) > 0 then
    perform _log(u.id, 'tenant.edited', 'Changed details of ' || _who(t.id) || ': ' || array_to_string(ch, '; '), t.id, _diff(to_jsonb(o), to_jsonb(t)));
  end if;
end $$;

create or replace function move_out(p_token text, p_tenancy uuid, p_end_date date) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies; owes numeric; credit numeric;
begin
  u := _staff(p_token);
  update tenancies set status = 'ended', end_date = coalesce(p_end_date, _today()) where id = p_tenancy and status = 'active' returning * into t;
  if not found then raise exception 'Tenant not found or already moved out'; end if;
  select (l->'totals'->>'outstanding')::numeric, (l->'totals'->>'credit')::numeric into owes, credit from _ledger(p_tenancy) l;
  perform _log(u.id, 'tenant.moved_out', 'Moved out ' || t.full_name || ' from Room ' || (select room_no from rooms where id = t.room_id) || ' on ' || _d(t.end_date) ||
               case when owes > 0 then ', still owes ' || _inr(owes) when credit > 0 then ', advance of ' || _inr(credit) || ' left' else ', nothing owed' end,
               p_tenancy, jsonb_build_object('end_date', t.end_date, 'outstanding', owes, 'credit', credit, 'deposit', t.deposit));
end $$;
-- =====================================================================
-- PART 5: bills, old dues, payments, deductions, requests, inbox, backup (owner/admin).
-- Every function that changes something also writes its Lodging line (_log), in the same step.
-- =====================================================================
create or replace function _create_bill(p_tenancy uuid, p_month date) returns uuid
language plpgsql set search_path = public as $$
declare s app_settings; t tenancies; m date := date_trunc('month', p_month)::date; prev numeric; bid uuid;
begin
  select * into s from app_settings where id = 1;
  select * into t from tenancies where id = p_tenancy;
  if not found then return null; end if;
  if exists (select 1 from bills where tenancy_id = t.id and month = m and kind = 'regular') then return null; end if;
  select new_reading into prev from bills where tenancy_id = t.id and kind = 'regular' and new_reading is not null and month < m order by month desc limit 1;
  insert into bills (tenancy_id, month, rent, persons, water_rate, water, prev_reading, elec_rate, due_date)
  values (t.id, m, t.rent, t.persons, s.water_rate, round(t.persons * s.water_rate, 2), coalesce(prev, t.opening_reading), s.electricity_rate,
          make_date(extract(year from m)::int, extract(month from m)::int, t.due_day))
  returning id into bid;
  if t.user_id is not null and t.status = 'active' then
    perform _notify(t.user_id, 'reading', 'Please send your meter reading',
      'Enter the electricity meter reading for ' || to_char(m, 'FMMonth YYYY') || ' so your bill can be made.', '#/home', 'reading0:' || bid);
  end if;
  return bid;
end $$;

create or replace function _create_bills(p_month date) returns int language plpgsql set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; t record; c int := 0;
begin
  for t in select id from tenancies where status = 'active' and start_date < (m + interval '1 month')::date loop
    if _create_bill(t.id, m) is not null then c := c + 1; end if;
  end loop;
  return c;
end $$;

create or replace function create_bills(p_token text, p_month date) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare u users; m date; c int;
begin
  u := _staff(p_token);
  m := date_trunc('month', coalesce(p_month, _today()))::date;
  c := _create_bills(m);
  if c > 0 then                                             -- one line for the whole press of the button
    perform _log(u.id, 'bill.bulk_created', 'Made ' || c || case when c = 1 then ' bill' else ' bills' end || ' for ' || to_char(m, 'FMMonth YYYY') || ' (all rooms)',
                 null, jsonb_build_object('month', m, 'count', c));
  end if;
  return c;
end $$;

create or replace function add_bill(p_token text, p_tenancy uuid, p_month date) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare u users; bid uuid; b bills;
begin
  u := _staff(p_token);
  if p_month is null or p_month < date '2000-01-01' then raise exception 'Choose a month'; end if;
  bid := _create_bill(p_tenancy, p_month);
  if bid is null then raise exception 'A bill for that month already exists'; end if;
  select * into b from bills where id = bid;
  perform _log(u.id, 'bill.created', 'Made the ' || _bill_label(b.month, b.kind) || ' bill for ' || _who(p_tenancy) || ': rent ' || _inr(b.rent) ||
               ' + water ' || _inr(b.water) || ', meter reading still to come', p_tenancy, jsonb_build_object('bill_id', bid, 'month', b.month));
  return bid;
end $$;

-- ---------- old dues: money a tenant already owed before this app (or any amount entered by hand) ----------
-- Kept as a bill of kind 'previous' with the placeholder month 1 January 1900 (never shown to anyone).
-- With a date ("owed since") the normal late-interest rule applies from that date. Without a date the dues
-- count as due the day they are entered and never earn interest (the owner can switch that later).
create or replace function _add_old_dues(p_actor uuid, p_tenancy uuid, p_amount numeric, p_note text, p_since date) returns uuid
language plpgsql set search_path = public as $$
declare bid uuid; note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not exists (select 1 from tenancies where id = p_tenancy) then raise exception 'Tenant not found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the old dues amount (more than zero)'; end if;
  if p_amount > 10000000 then raise exception 'That amount is too large. Please check it.'; end if;
  if p_since is not null and p_since > _today() then raise exception 'The "owed since" date cannot be in the future'; end if;
  if p_since is not null and p_since < date '2000-01-01' then raise exception 'The "owed since" date cannot be before the year 2000'; end if;
  if length(coalesce(note, '')) > 200 then raise exception 'The note is too long (200 letters at most)'; end if;
  insert into bills (tenancy_id, month, kind, rent, persons, water_rate, water, prev_reading, new_reading, elec_rate, electricity, due_date, interest_waived, note)
  values (p_tenancy, date '1900-01-01', 'previous', round(p_amount, 2), 0, 0, 0, 0, null, 0, 0, coalesce(p_since, _today()), p_since is null, note)
  returning id into bid;
  perform _log(p_actor, 'dues.added', 'Added old dues ' || _inr(p_amount) || coalesce(' (' || note || ')', '') || ' for ' || _who(p_tenancy) ||
               case when p_since is null then ', no date (no late interest)' else ', owed since ' || _d(p_since) end,
               p_tenancy, jsonb_build_object('bill_id', bid, 'amount', round(p_amount, 2), 'note', note, 'since', p_since));
  return bid;
end $$;

create or replace function add_old_dues(p_token text, p_tenancy uuid, p_amount numeric, p_note text, p_since date) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _staff(p_token);
  return _add_old_dues(u.id, p_tenancy, p_amount, p_note, p_since);
end $$;

-- The old website's list of one month's bills. The new website uses building_bill instead; this stays so that
-- a phone still showing the old website keeps working.
create or replace function billing_month(p_token text, p_month date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; m date := date_trunc('month', coalesce(p_month, _today()))::date; r record; b jsonb; out jsonb := '[]'::jsonb; missing int := 0;
begin
  u := _staff(p_token);
  for r in select t.id, t.full_name, rm.room_no from tenancies t join rooms rm on rm.id = t.room_id
           where t.status = 'active' and t.start_date < (m + interval '1 month')::date order by length(rm.room_no), rm.room_no loop
    select x into b from jsonb_array_elements(_ledger(r.id)->'bills') x where (x->>'month')::date = m and x->>'kind' = 'regular';
    if b is null then missing := missing + 1; end if;
    out := out || jsonb_build_object('tenancy_id', r.id, 'tenant', r.full_name, 'room_no', r.room_no, 'bill', b);
  end loop;
  return jsonb_build_object('month', m, 'rows', out, 'missing', missing);
end $$;

create or replace function update_bill(p_token text, p_bill uuid, p_fields jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; o bills; n bills; ch text[] := '{}'; lbl text; d jsonb;
begin
  u := _staff(p_token);
  select * into o from bills where id = p_bill for update;
  if not found then raise exception 'Bill not found'; end if;
  if o.kind = 'previous' then
    -- Old dues have only an amount, a note, a date and the interest switch. Anything else that is sent is ignored.
    if p_fields ? 'rent' and coalesce((p_fields->>'rent')::numeric, 0) <= 0 then raise exception 'Enter the old dues amount (more than zero)'; end if;
    if (p_fields->>'rent')::numeric > 10000000 then raise exception 'That amount is too large. Please check it.'; end if;
    if (p_fields->>'due_date')::date > _today() then raise exception 'The "owed since" date cannot be in the future'; end if;
    if (p_fields->>'due_date')::date < date '2000-01-01' then raise exception 'The "owed since" date cannot be before the year 2000'; end if;
    if length(trim(coalesce(p_fields->>'note', ''))) > 200 then raise exception 'The note is too long (200 letters at most)'; end if;
    update bills set
      rent = coalesce(round((p_fields->>'rent')::numeric, 2), rent),
      due_date = coalesce((p_fields->>'due_date')::date, due_date),
      interest_waived = coalesce((p_fields->>'interest_waived')::boolean, interest_waived),
      note = case when p_fields ? 'note' then nullif(trim(p_fields->>'note'), '') else note end
    where id = p_bill returning * into n;
  else
    update bills set
      rent = coalesce((p_fields->>'rent')::numeric, rent),
      persons = coalesce((p_fields->>'persons')::int, persons),
      water_rate = coalesce((p_fields->>'water_rate')::numeric, water_rate),
      prev_reading = coalesce((p_fields->>'prev_reading')::numeric, prev_reading),
      new_reading = case when p_fields ? 'new_reading' then nullif(p_fields->>'new_reading', '')::numeric else new_reading end,
      elec_rate = coalesce((p_fields->>'elec_rate')::numeric, elec_rate),
      due_date = coalesce((p_fields->>'due_date')::date, due_date),
      interest_waived = coalesce((p_fields->>'interest_waived')::boolean, interest_waived),
      note = case when p_fields ? 'note' then nullif(trim(p_fields->>'note'), '') else note end,
      reading_verified = case when p_fields ? 'new_reading' then true else coalesce((p_fields->>'reading_verified')::boolean, reading_verified) end,
      reading_by = case when p_fields ? 'new_reading' then coalesce(reading_by, u.id) else reading_by end,
      reading_at = case when p_fields ? 'new_reading' then coalesce(reading_at, now()) else reading_at end
    where id = p_bill;
    perform _recalc_bill(p_bill);
    select * into n from bills where id = p_bill;
  end if;

  -- The Lodging line: what changed, old value to new value.
  if n.rent is distinct from o.rent then ch := ch || ((case when o.kind = 'previous' then 'amount ' else 'rent ' end) || _inr(o.rent) || ' to ' || _inr(n.rent)); end if;
  if n.persons is distinct from o.persons then ch := ch || ('people ' || o.persons || ' to ' || n.persons); end if;
  if n.water_rate is distinct from o.water_rate then ch := ch || ('water rate ' || _inr(o.water_rate) || ' to ' || _inr(n.water_rate)); end if;
  if n.prev_reading is distinct from o.prev_reading then ch := ch || ('previous reading ' || _n(o.prev_reading) || ' to ' || _n(n.prev_reading)); end if;
  if n.new_reading is distinct from o.new_reading then ch := ch || ('meter reading ' || coalesce(_n(o.new_reading), 'none') || ' to ' || coalesce(_n(n.new_reading), 'none')); end if;
  if n.elec_rate is distinct from o.elec_rate then ch := ch || ('unit rate ' || _inr(o.elec_rate) || ' to ' || _inr(n.elec_rate)); end if;
  if n.due_date is distinct from o.due_date then ch := ch || ((case when o.kind = 'previous' then 'date ' else 'due date ' end) || _d(o.due_date) || ' to ' || _d(n.due_date)); end if;
  if n.interest_waived is distinct from o.interest_waived then
    ch := ch || ('late interest ' || case when o.interest_waived then 'off' else 'on' end || ' to ' || case when n.interest_waived then 'off' else 'on' end);
  end if;
  if n.note is distinct from o.note then ch := ch || 'note changed'::text; end if;
  lbl := case when o.kind = 'previous' then 'old dues of ' else 'the ' || _bill_label(o.month, o.kind) || ' bill of ' end || _who(o.tenancy_id);
  d := _diff(to_jsonb(o), to_jsonb(n));
  if coalesce(array_length(ch, 1), 0) > 0 then
    perform _log(u.id, 'bill.edited', 'Changed ' || lbl || ': ' || array_to_string(ch, '; ') ||
                 case when n.reading_verified and not o.reading_verified and n.new_reading is not distinct from o.new_reading then '; meter reading checked' else '' end,
                 o.tenancy_id, d || jsonb_build_object('bill_id', o.id));
  elsif n.reading_verified and not o.reading_verified then
    perform _log(u.id, 'reading.checked', 'Checked the meter reading ' || coalesce(_n(n.new_reading), 'none') || ' for ' || lbl || ' (' ||
                 _n(greatest(coalesce(n.new_reading, n.prev_reading) - n.prev_reading, 0)) || ' units, ' || _inr(n.electricity) || ')',
                 o.tenancy_id, jsonb_build_object('bill_id', o.id, 'reading', n.new_reading, 'electricity', n.electricity));
  end if;
end $$;

-- Deleting a bill. There is only one copy of a bill, so it is gone from every screen at once.
-- Payments are never deleted: money that was applied to this bill is applied to the tenant's other bills
-- (or kept as advance credit) the next time anything is worked out.
create or replace function delete_bill(p_token text, p_bill uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; b bills; bj jsonb; paid numeric; ded numeric; lbl text;
begin
  u := _staff(p_token);
  select * into b from bills where id = p_bill for update;
  if not found then raise exception 'Bill not found. It may have been deleted already.'; end if;
  -- A picture of the bill as it was, for the Lodging line.
  select x into bj from jsonb_array_elements(_ledger(b.tenancy_id)->'bills') x where (x->>'id')::uuid = b.id;
  paid := coalesce((bj->>'principal_paid')::numeric, 0) + coalesce((bj->>'interest_paid')::numeric, 0);
  select coalesce(-sum(a.amount), 0) into ded from bill_adjustments a where a.bill_id = b.id and a.claim_id is not null;
  lbl := case when b.kind = 'previous' then 'old dues' || coalesce(' (' || b.note || ')', '') || ' of ' else 'the ' || _bill_label(b.month, b.kind) || ' bill of ' end || _who(b.tenancy_id);
  -- Approved deduction requests that sat on this bill are no longer given: mark them so the tenant sees why.
  update deduction_claims c set status = 'rejected', approved = null,
         decision_note = coalesce(c.decision_note || ' ', '') || '(removed because the bill was deleted)'
  where c.id in (select a.claim_id from bill_adjustments a where a.bill_id = b.id and a.claim_id is not null);
  perform _log(u.id, 'bill.deleted', 'Deleted ' || lbl || ', total ' || _inr((bj->>'total')::numeric) || '.' ||
               case when paid > 0 then ' ' || _inr(paid) || ' already paid against it stays with the tenant and is used for other bills.' else '' end ||
               case when b.kind = 'regular' and b.new_reading is not null then ' The meter reading ' || _n(b.new_reading) || ' was removed.' else '' end ||
               case when ded > 0 then ' Approved deductions of ' || _inr(ded) || ' were removed.' else '' end,
               b.tenancy_id, jsonb_build_object('bill', bj, 'paid_against_it', paid, 'deductions_removed', ded));
  delete from bills where id = b.id;
end $$;

create or replace function add_adjustment(p_token text, p_bill uuid, p_label text, p_amount numeric) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; b bills; amt numeric;
begin
  u := _staff(p_token);
  if coalesce(trim(p_label), '') = '' or p_amount is null or p_amount = 0 then raise exception 'Please enter a label and a non-zero amount'; end if;
  select * into b from bills where id = p_bill;
  if not found then raise exception 'Bill not found'; end if;
  amt := round(p_amount, 2);
  insert into bill_adjustments (bill_id, label, amount, created_by) values (p_bill, trim(p_label), amt, u.id);
  perform _log(u.id, 'adjustment.added',
    case when amt < 0 then 'Subtracted ' || _inr(-amt) || ' (' || trim(p_label) || ') from ' else 'Added a charge of ' || _inr(amt) || ' (' || trim(p_label) || ') to ' end ||
    case when b.kind = 'previous' then 'old dues of ' else 'the ' || _bill_label(b.month, b.kind) || ' bill of ' end || _who(b.tenancy_id),
    b.tenancy_id, jsonb_build_object('bill_id', b.id, 'label', trim(p_label), 'amount', amt));
end $$;

create or replace function delete_adjustment(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; a bill_adjustments; b bills;
begin
  u := _staff(p_token);
  delete from bill_adjustments where id = p_id returning * into a;
  if not found then return; end if;
  if a.claim_id is not null then
    update deduction_claims set status = 'rejected', approved = null, decision_note = coalesce(decision_note || ' ', '') || '(removed from the bill)' where id = a.claim_id;
  end if;
  select * into b from bills where id = a.bill_id;
  perform _log(u.id, 'adjustment.removed',
    'Removed the ' || case when a.amount < 0 then 'deduction of ' || _inr(-a.amount) else 'charge of ' || _inr(a.amount) end || ' (' || a.label || ') from ' ||
    case when b.kind = 'previous' then 'old dues of ' else 'the ' || _bill_label(b.month, b.kind) || ' bill of ' end || _who(b.tenancy_id),
    b.tenancy_id, jsonb_build_object('bill_id', b.id, 'label', a.label, 'amount', a.amount, 'claim_id', a.claim_id));
end $$;

-- ---------- payments ----------
create or replace function _check_payment(p_amount numeric, p_paid_on date, p_method text) returns void language plpgsql set search_path = public as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount greater than zero'; end if;
  if p_paid_on is null then raise exception 'Choose the date of payment'; end if;
  if p_paid_on > _today() then raise exception 'The payment date cannot be in the future'; end if;
  if p_method not in ('cash','upi','bank','other') then raise exception 'Choose how it was paid'; end if;
end $$;

-- How a way of paying is written in a sentence.
create or replace function _method_name(p text) returns text language sql immutable as $$
  select case p when 'cash' then 'cash' when 'upi' then 'UPI' when 'bank' then 'bank transfer' else 'other' end
$$;

create or replace function record_payment(p_token text, p_tenancy uuid, p_amount numeric, p_paid_on date, p_method text,
                                          p_reference text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies; rn text; pid uuid;
begin
  u := _staff(p_token);
  select * into t from tenancies where id = p_tenancy;
  if not found then raise exception 'Tenant not found'; end if;
  perform _check_payment(p_amount, p_paid_on, p_method);
  rn := _next_receipt(p_paid_on);
  insert into payments (tenancy_id, amount, paid_on, method, reference, note, status, submitted_by, by_tenant, receipt_no, decided_by, decided_at)
  values (p_tenancy, round(p_amount, 2), p_paid_on, p_method, nullif(trim(p_reference), ''), nullif(trim(p_note), ''), 'approved', u.id, false, rn, u.id, now())
  returning id into pid;
  if t.user_id is not null then
    perform _notify(t.user_id, 'payment', 'Payment received', _inr(p_amount) || ' received on ' || to_char(p_paid_on, 'DD Mon YYYY') || '. Receipt ' || rn || '.', '#/payments');
  end if;
  perform _log(u.id, 'payment.recorded', 'Recorded ' || _inr(p_amount) || ' ' || _method_name(p_method) || ' from ' || _who_p(p_tenancy) || ', paid on ' || _d(p_paid_on) || ', receipt ' || rn,
               p_tenancy, jsonb_build_object('payment_id', pid, 'amount', round(p_amount, 2), 'paid_on', p_paid_on, 'method', p_method,
                                             'reference', nullif(trim(p_reference), ''), 'note', nullif(trim(p_note), ''), 'receipt_no', rn));
  return jsonb_build_object('id', pid, 'receipt_no', rn);
end $$;

create or replace function decide_payment(p_token text, p_payment uuid, p_approve boolean, p_amount numeric default null,
                                          p_paid_on date default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; p payments; uid uuid; amt numeric; pd date; rn text;
begin
  u := _staff(p_token);
  select * into p from payments where id = p_payment for update;
  if not found or p.status <> 'pending' then raise exception 'This payment was already handled'; end if;
  select user_id into uid from tenancies where id = p.tenancy_id;
  if p_approve then
    amt := round(coalesce(p_amount, p.amount), 2); pd := coalesce(p_paid_on, p.paid_on);
    perform _check_payment(amt, pd, p.method);
    rn := _next_receipt(pd);
    update payments set status = 'approved', amount = amt, paid_on = pd, receipt_no = rn, decided_by = u.id, decided_at = now(),
           decision_note = nullif(trim(p_note), '') where id = p.id;
    if uid is not null then
      perform _notify(uid, 'payment', 'Payment confirmed',
        case when amt <> p.amount then 'You reported ' || _inr(p.amount) || '; the owner confirmed ' || _inr(amt) || '.'
             else _inr(amt) || ' confirmed.' end || ' Receipt ' || rn || '.', '#/payments');
    end if;
    perform _log(u.id, 'payment.approved', 'Approved ' || _inr(amt) || ' ' || _method_name(p.method) || ' from ' || _who_p(p.tenancy_id) || ', receipt ' || rn ||
                 case when amt <> p.amount then ' (reported ' || _inr(p.amount) || ', confirmed ' || _inr(amt) || ')' else '' end ||
                 case when pd <> p.paid_on then ' (date ' || _d(p.paid_on) || ' changed to ' || _d(pd) || ')' else '' end,
                 p.tenancy_id, jsonb_build_object('payment_id', p.id, 'reported', jsonb_build_object('amount', p.amount, 'paid_on', p.paid_on),
                   'confirmed', jsonb_build_object('amount', amt, 'paid_on', pd), 'method', p.method, 'reference', p.reference, 'receipt_no', rn, 'note', nullif(trim(p_note), '')));
    return jsonb_build_object('receipt_no', rn);
  end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Please write a short reason so the tenant knows why'; end if;
  update payments set status = 'rejected', decided_by = u.id, decided_at = now(), decision_note = trim(p_note) where id = p.id;
  if uid is not null then
    perform _notify(uid, 'payment', 'Payment not confirmed', 'Your report of ' || _inr(p.amount) || ' was not confirmed: ' || trim(p_note), '#/payments');
  end if;
  perform _log(u.id, 'payment.rejected', 'Did not confirm ' || _inr(p.amount) || ' ' || _method_name(p.method) || ' reported by ' || _who_p(p.tenancy_id) || '. Reason: ' || trim(p_note),
               p.tenancy_id, jsonb_build_object('payment_id', p.id, 'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method, 'reference', p.reference, 'reason', trim(p_note)));
  return jsonb_build_object('rejected', true);
end $$;

create or replace function void_payment(p_token text, p_payment uuid, p_note text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; p payments; uid uuid;
begin
  u := _staff(p_token);
  if coalesce(trim(p_note), '') = '' then raise exception 'Please write the reason for cancelling this payment'; end if;
  update payments set status = 'void', decision_note = trim(p_note), decided_by = u.id, decided_at = now()
  where id = p_payment and status = 'approved' returning * into p;
  if not found then raise exception 'Only a confirmed payment can be cancelled'; end if;
  select user_id into uid from tenancies where id = p.tenancy_id;
  if uid is not null then
    perform _notify(uid, 'payment', 'Payment cancelled', 'Receipt ' || p.receipt_no || ' (' || _inr(p.amount) || ') was cancelled: ' || trim(p_note), '#/payments');
  end if;
  perform _log(u.id, 'payment.voided', 'Cancelled receipt ' || p.receipt_no || ': ' || _inr(p.amount) || ' ' || _method_name(p.method) || ' from ' || _who_p(p.tenancy_id) ||
               ', paid on ' || _d(p.paid_on) || '. Reason: ' || trim(p_note),
               p.tenancy_id, jsonb_build_object('payment_id', p.id, 'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method, 'receipt_no', p.receipt_no, 'reason', trim(p_note)));
end $$;

-- ---------- correcting a payment that was already confirmed ----------
-- p_fields may carry: amount, paid_on, method, reference, note. A reason is required. The receipt number never changes.
-- The tenant is told (like when a payment is cancelled), without the name of the master who did it.
create or replace function edit_payment(p_token text, p_payment uuid, p_fields jsonb, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; o payments; n payments; uid uuid; ch text[] := '{}'; f jsonb := coalesce(p_fields, '{}'::jsonb);
begin
  u := _staff(p_token);
  select * into o from payments where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  if o.status <> 'approved' then raise exception 'Only a confirmed payment can be corrected'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Please write the reason for this correction'; end if;
  n := o;
  if f ? 'amount' then n.amount := round((f->>'amount')::numeric, 2); end if;
  if f ? 'paid_on' then n.paid_on := (f->>'paid_on')::date; end if;
  if f ? 'method' then n.method := f->>'method'; end if;
  if f ? 'reference' then n.reference := nullif(trim(f->>'reference'), ''); end if;
  if f ? 'note' then n.note := nullif(trim(f->>'note'), ''); end if;
  perform _check_payment(n.amount, n.paid_on, n.method);
  if n.amount is distinct from o.amount then ch := ch || ('amount ' || _inr(o.amount) || ' to ' || _inr(n.amount)); end if;
  if n.paid_on is distinct from o.paid_on then ch := ch || ('date ' || _d(o.paid_on) || ' to ' || _d(n.paid_on)); end if;
  if n.method is distinct from o.method then ch := ch || ('paid by ' || _method_name(o.method) || ' to ' || _method_name(n.method)); end if;
  if n.reference is distinct from o.reference then ch := ch || ('reference ' || coalesce(o.reference, 'none') || ' to ' || coalesce(n.reference, 'none')); end if;
  if n.note is distinct from o.note then ch := ch || 'note changed'::text; end if;
  if coalesce(array_length(ch, 1), 0) = 0 then raise exception 'Nothing was changed. Change the amount, date or another detail first.'; end if;
  update payments set amount = n.amount, paid_on = n.paid_on, method = n.method, reference = n.reference, note = n.note,
         edited_at = now(), edited_by = u.id, edit_note = trim(p_reason) where id = o.id;
  select user_id into uid from tenancies where id = o.tenancy_id;
  if uid is not null then
    perform _notify(uid, 'payment', 'Payment corrected', 'Receipt ' || o.receipt_no || ' was corrected: ' || array_to_string(ch, ', ') || '. Reason: ' || trim(p_reason), '#/payments');
  end if;
  perform _log(u.id, 'payment.corrected', 'Corrected receipt ' || o.receipt_no || ' of ' || _who_p(o.tenancy_id) || ': ' || array_to_string(ch, ', ') || '. Reason: ' || trim(p_reason),
               o.tenancy_id, jsonb_build_object('payment_id', o.id, 'receipt_no', o.receipt_no, 'reason', trim(p_reason)) ||
               _diff(jsonb_build_object('amount', o.amount, 'paid_on', o.paid_on, 'method', o.method, 'reference', o.reference, 'note', o.note),
                     jsonb_build_object('amount', n.amount, 'paid_on', n.paid_on, 'method', n.method, 'reference', n.reference, 'note', n.note)));
end $$;

-- Every payment dated in one month, whatever its state, for the "Payments" view of Billing.
-- "approved_total" is the money really collected: for the current month it is the "Collected this month" box.
create or replace function payments_month(p_token text, p_month date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; m date := date_trunc('month', coalesce(p_month, _today()))::date; m2 date;
begin
  u := _staff(p_token);
  m2 := (m + interval '1 month')::date;
  return jsonb_build_object('month', m, 'today', _today(),
    'approved_total', coalesce((select sum(amount) from payments where status = 'approved' and paid_on >= m and paid_on < m2), 0),
    'approved_count', (select count(*) from payments where status = 'approved' and paid_on >= m and paid_on < m2),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'tenancy_id', p.tenancy_id, 'room_id', t.room_id, 'room_no', r.room_no, 'tenant', t.full_name,
        'phone', t.phone, 'tenancy_status', t.status,
        'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method, 'reference', p.reference, 'note', p.note, 'receipt_no', p.receipt_no,
        'status', p.status, 'by_tenant', p.by_tenant, 'proof_id', p.proof, 'created_at', p.created_at,
        'decided_by', (select full_name from users where id = p.decided_by), 'decided_at', p.decided_at, 'decision_note', p.decision_note,
        'edited_at', p.edited_at, 'edited_by', (select full_name from users where id = p.edited_by), 'edit_note', p.edit_note)
        order by p.paid_on desc, p.created_at desc, p.id)
      from payments p join tenancies t on t.id = p.tenancy_id join rooms r on r.id = t.room_id
      where p.paid_on >= m and p.paid_on < m2), '[]'::jsonb));
end $$;

-- ---------- the building bill: one line per room for one month ----------
-- Each line = that month's bill + the tenant's whole position "as on" a date, all taken from _ledger, so it can
-- never disagree with the room page. For every line:  this month + interest - paid + other dues = to pay.
-- The "as on" date cannot be before the 1st of the month looked at; the date really used is returned.
create or replace function building_bill(p_token text, p_month date, p_as_of date default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; m date := date_trunc('month', coalesce(p_month, _today()))::date; asof date; r record; led jsonb; tot jsonb; b jsonb;
  rows_out jsonb := '[]'::jsonb; row jsonb; rem record;
  this_out numeric; n_rooms int := 0; n_vacant int := 0; n_billed int := 0; n_nobill int := 0; n_reading int := 0; n_tenants int := 0;
begin
  u := _staff(p_token);
  asof := greatest(coalesce(p_as_of, _today()), m);
  for r in
    select rm.id as room_id, rm.room_no, t.id as tid, t.full_name, t.phone, t.user_id, t.start_date
    from rooms rm left join tenancies t on t.room_id = rm.id and t.status = 'active'
    where rm.active order by length(rm.room_no), rm.room_no
  loop
    n_rooms := n_rooms + 1;
    if r.tid is null then
      n_vacant := n_vacant + 1;
      rows_out := rows_out || jsonb_build_object('room_id', r.room_id, 'room_no', r.room_no, 'vacant', true);
      continue;
    end if;
    continue when r.start_date >= (m + interval '1 month')::date;      -- this tenant had not moved in yet in the month looked at
    n_tenants := n_tenants + 1;
    led := _ledger(r.tid, asof); tot := led->'totals';
    select x into b from jsonb_array_elements(led->'bills') x where x->>'kind' = 'regular' and (x->>'month')::date = m;
    select a.at, split_part(a.action, '.', 2) as channel into rem from audit_log a where a.tenancy_id = r.tid and a.action like 'reminder.%' order by a.at desc, a.id desc limit 1;
    row := jsonb_build_object('room_id', r.room_id, 'room_no', r.room_no, 'vacant', false, 'tenancy_id', r.tid, 'tenant', r.full_name, 'phone', r.phone,
      'has_login', r.user_id is not null,
      'to_pay', tot->'outstanding', 'credit', tot->'credit', 'overdue', (tot->>'overdue_bills')::int > 0, 'max_days_late', tot->'max_days_late',
      'interest_due', tot->'interest_due', 'unpaid', (tot->>'outstanding')::numeric > 0,
      'last_reminder', case when rem.at is null then null else jsonb_build_object('at', rem.at, 'channel', rem.channel) end);
    if b is null then
      n_nobill := n_nobill + 1;
      row := row || jsonb_build_object('no_bill', true, 'bill_id', null, 'rent', 0, 'water', 0, 'electricity', 0, 'other', 0, 'this_month', 0, 'interest', 0, 'paid', 0,
        'other_dues', tot->'outstanding', 'awaiting_reading', false, 'status', null, 'due_date', null, 'bill_interest_left', 0, 'bill_overdue', false);
    else
      n_billed := n_billed + 1;
      if (b->>'awaiting_reading')::boolean then n_reading := n_reading + 1; end if;
      this_out := (b->>'outstanding')::numeric;
      row := row || jsonb_build_object('no_bill', false, 'bill_id', b->'id', 'rent', b->'rent', 'water', b->'water', 'electricity', b->'electricity',
        'other', (b->>'total')::numeric - (b->>'rent')::numeric - (b->>'water')::numeric - (b->>'electricity')::numeric,
        'this_month', b->'total', 'interest', b->'interest_charged',
        'paid', (b->>'total')::numeric + (b->>'interest_charged')::numeric - this_out,
        'other_dues', (tot->>'outstanding')::numeric - this_out,
        'awaiting_reading', b->'awaiting_reading', 'status', b->'status', 'due_date', b->'due_date', 'bill_overdue', b->'is_overdue',
        'bill_interest_left', b->'interest_left');
    end if;
    rows_out := rows_out || row;
  end loop;
  return jsonb_build_object('month', m, 'as_of', asof, 'today', _today(), 'rows', rows_out,
    'totals', (select jsonb_build_object(
        'rent', coalesce(sum((x->>'rent')::numeric), 0), 'water', coalesce(sum((x->>'water')::numeric), 0), 'electricity', coalesce(sum((x->>'electricity')::numeric), 0),
        'other', coalesce(sum((x->>'other')::numeric), 0), 'this_month', coalesce(sum((x->>'this_month')::numeric), 0), 'interest', coalesce(sum((x->>'interest')::numeric), 0),
        'paid', coalesce(sum((x->>'paid')::numeric), 0), 'other_dues', coalesce(sum((x->>'other_dues')::numeric), 0), 'to_pay', coalesce(sum((x->>'to_pay')::numeric), 0),
        'credit', coalesce(sum((x->>'credit')::numeric), 0))
      from jsonb_array_elements(rows_out) x where not (x->>'vacant')::boolean),
    'summary', jsonb_build_object('rooms', n_rooms, 'tenants', n_tenants, 'billed', n_billed, 'no_bill', n_nobill, 'vacant', n_vacant, 'readings_missing', n_reading,
      'to_collect', (select coalesce(sum((x->>'to_pay')::numeric), 0) from jsonb_array_elements(rows_out) x where not (x->>'vacant')::boolean),
      'overdue_rooms', (select count(*) from jsonb_array_elements(rows_out) x where (x->>'overdue')::boolean)));
end $$;

-- ---------- documents kept with a tenant (Aadhaar photo, agreement) - masters only ----------
-- Accepts a JPEG, PNG or WebP picture (about 800 KB at most) or a PDF (about 1.5 MB at most), as stored text.
create or replace function _save_document(p_user uuid, p_data text, out aid uuid, out mime text, out size_kb int)
language plpgsql set search_path = public as $$
begin
  if p_data is null or p_data = '' then raise exception 'Choose a photo or a PDF file first'; end if;
  mime := substring(left(p_data, 60) from '^data:(image/jpeg|image/png|image/webp|application/pdf);base64,');
  if mime is null then raise exception 'Only photos (JPEG, PNG, WebP) and PDF files can be kept as documents'; end if;
  if mime = 'application/pdf' and length(p_data) > 1600000 then raise exception 'This PDF is too large (about 1 MB at most). Please make it smaller or take photos of the pages.'; end if;
  if mime <> 'application/pdf' and length(p_data) > 850000 then raise exception 'The photo is too large. Please try a smaller one.'; end if;
  size_kb := ceil(length(p_data) / 1024.0)::int;
  insert into attachments (data, uploaded_by) values (p_data, p_user) returning id into aid;
end $$;

create or replace function tenant_documents_list(p_token text, p_tenancy uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _staff(p_token);
  if not exists (select 1 from tenancies where id = p_tenancy) then raise exception 'Tenant not found'; end if;
  return jsonb_build_object(
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'attachment_id', d.attachment_id, 'mime', d.mime, 'size_kb', d.size_kb,
        'added_by', (select full_name from users where id = d.added_by), 'created_at', d.created_at) order by d.created_at, d.id)
        from tenant_documents d where d.tenancy_id = p_tenancy), '[]'::jsonb),
    'total_kb', coalesce((select sum(size_kb) from tenant_documents where tenancy_id = p_tenancy), 0),
    'all_documents_kb', coalesce((select sum(size_kb) from tenant_documents), 0),
    'max_documents', 10);
end $$;

create or replace function add_tenant_document(p_token text, p_tenancy uuid, p_title text, p_data text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; s record; did uuid; title text := trim(coalesce(p_title, ''));
begin
  u := _staff(p_token);
  if not exists (select 1 from tenancies where id = p_tenancy) then raise exception 'Tenant not found'; end if;
  if title = '' then raise exception 'Please give the document a title (for example: Aadhaar front)'; end if;
  if length(title) > 80 then raise exception 'The title is too long (80 letters at most)'; end if;
  if (select count(*) from tenant_documents where tenancy_id = p_tenancy) >= 10 then
    raise exception 'This tenant already has 10 documents. Delete one before adding another.';
  end if;
  s := _save_document(u.id, p_data);
  insert into tenant_documents (tenancy_id, title, attachment_id, mime, size_kb, added_by) values (p_tenancy, title, s.aid, s.mime, s.size_kb, u.id) returning id into did;
  perform _log(u.id, 'document.added', 'Added a document "' || title || '" (' || case when s.mime = 'application/pdf' then 'PDF' else 'photo' end || ', ' || s.size_kb || ' KB) for ' || _who(p_tenancy),
               p_tenancy, jsonb_build_object('document_id', did, 'title', title, 'mime', s.mime, 'size_kb', s.size_kb));
  return jsonb_build_object('id', did, 'attachment_id', s.aid, 'mime', s.mime, 'size_kb', s.size_kb);
end $$;

create or replace function delete_tenant_document(p_token text, p_doc uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; d tenant_documents;
begin
  u := _staff(p_token);
  select * into d from tenant_documents where id = p_doc;
  if not found then raise exception 'Document not found. It may have been deleted already.'; end if;
  perform _log(u.id, 'document.deleted', 'Deleted the document "' || d.title || '" of ' || _who(d.tenancy_id),
               d.tenancy_id, jsonb_build_object('document_id', d.id, 'title', d.title, 'mime', d.mime, 'size_kb', d.size_kb));
  delete from attachments where id = d.attachment_id;        -- the file itself; the document row goes with it
  delete from tenant_documents where id = d.id;
end $$;

-- How full the database is (the free plan allows 500 MB). Photos and documents are what can fill it.
create or replace function storage_info(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _staff(p_token);
  return jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'limit_bytes', 500 * 1024 * 1024::bigint,
    'documents_bytes', coalesce((select sum(length(a.data)) from attachments a where exists (select 1 from tenant_documents d where d.attachment_id = a.id)), 0),
    'photos_bytes', coalesce((select sum(length(a.data)) from attachments a where not exists (select 1 from tenant_documents d where d.attachment_id = a.id)), 0),
    'documents', (select count(*) from tenant_documents));
end $$;

-- ---------- maintenance done by the tenant (deduction) ----------
create or replace function decide_deduction(p_token text, p_claim uuid, p_approve boolean, p_amount numeric default null,
                                            p_bill uuid default null, p_note text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; c deduction_claims; uid uuid; bid uuid; amt numeric; b bills;
begin
  u := _staff(p_token);
  select * into c from deduction_claims where id = p_claim for update;
  if not found or c.status <> 'pending' then raise exception 'This request was already handled'; end if;
  select user_id into uid from tenancies where id = c.tenancy_id;
  if p_approve then
    -- Unless a bill is picked by hand, the deduction goes on the latest MONTHLY bill (never on old dues by itself).
    bid := coalesce(p_bill, (select id from bills where tenancy_id = c.tenancy_id and kind = 'regular' order by month desc limit 1));
    select * into b from bills where id = bid and tenancy_id = c.tenancy_id;
    if bid is null or not found then
      raise exception 'There is no bill to subtract this from yet. Create the bill first, then approve.';
    end if;
    amt := round(coalesce(p_amount, c.requested), 2);
    if amt <= 0 then raise exception 'Enter an amount greater than zero'; end if;
    insert into bill_adjustments (bill_id, label, amount, claim_id, created_by)
    values (bid, 'Maintenance done by tenant: ' || c.description, -amt, c.id, u.id);
    update deduction_claims set status = 'approved', approved = amt, bill_id = bid, decided_by = u.id, decided_at = now(), decision_note = nullif(trim(p_note), '') where id = c.id;
    if uid is not null then
      perform _notify(uid, 'deduction', 'Maintenance deduction approved', _inr(amt) || ' will be subtracted from your bill' ||
        case when amt <> c.requested then ' (you asked for ' || _inr(c.requested) || ')' else '' end || '.', '#/home');
    end if;
    perform _log(u.id, 'claim.approved', 'Approved a deduction of ' || _inr(amt) || ' for ' || _who(c.tenancy_id) || ' (' || c.description || '), taken off ' ||
                 case when b.kind = 'previous' then 'old dues' else 'the ' || _bill_label(b.month, b.kind) || ' bill' end ||
                 case when amt <> c.requested then ' (asked ' || _inr(c.requested) || ', approved ' || _inr(amt) || ')' else '' end,
                 c.tenancy_id, jsonb_build_object('claim_id', c.id, 'asked', c.requested, 'approved', amt, 'bill_id', bid, 'note', nullif(trim(p_note), '')));
  else
    if coalesce(trim(p_note), '') = '' then raise exception 'Please write a short reason'; end if;
    update deduction_claims set status = 'rejected', decided_by = u.id, decided_at = now(), decision_note = trim(p_note) where id = c.id;
    if uid is not null then
      perform _notify(uid, 'deduction', 'Maintenance deduction not approved', trim(p_note), '#/home');
    end if;
    perform _log(u.id, 'claim.rejected', 'Did not approve the deduction of ' || _inr(c.requested) || ' asked by ' || _who(c.tenancy_id) || ' (' || c.description || '). Reason: ' || trim(p_note),
                 c.tenancy_id, jsonb_build_object('claim_id', c.id, 'asked', c.requested, 'reason', trim(p_note)));
  end if;
end $$;

-- ---------- requests and complaints ----------
create or replace function update_ticket(p_token text, p_ticket uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; o tickets; k tickets; uid uuid;
begin
  u := _staff(p_token);
  if p_status not in ('open','seen','in_progress','done','closed') then raise exception 'Unknown status'; end if;
  select * into o from tickets where id = p_ticket for update;
  if not found then raise exception 'Request not found'; end if;
  update tickets set status = p_status, owner_note = case when p_note is null then owner_note else nullif(trim(p_note), '') end, updated_at = now()
  where id = p_ticket returning * into k;
  select user_id into uid from tenancies where id = k.tenancy_id;
  if uid is not null and k.kind <> 'complaint' then
    perform _notify(uid, 'ticket', 'Update on: ' || k.title, 'Status: ' || replace(p_status, '_', ' ') ||
      case when k.owner_note is not null then '. ' || k.owner_note else '' end, '#/requests');
  end if;
  if k.status is distinct from o.status or k.owner_note is distinct from o.owner_note then
    perform _log(u.id, 'ticket.updated', 'Request "' || k.title || '" from ' || _who(k.tenancy_id) || ': ' ||
                 case when k.status is distinct from o.status then 'status ' || replace(o.status, '_', ' ') || ' to ' || replace(k.status, '_', ' ') else 'status ' || replace(k.status, '_', ' ') end ||
                 case when k.owner_note is distinct from o.owner_note and k.owner_note is not null then '. Note: ' || k.owner_note else '' end,
                 k.tenancy_id, jsonb_build_object('ticket_id', k.id) || _diff(to_jsonb(o) - 'updated_at', to_jsonb(k) - 'updated_at'));
  end if;
end $$;

-- ---------- inbox, attachments, backup ----------
create or replace function inbox(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _staff(p_token);
  return jsonb_build_object(
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'tenancy_id', p.tenancy_id, 'room_no', r.room_no, 'tenant', t.full_name,
        'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method, 'reference', p.reference, 'note', p.note, 'proof_id', p.proof, 'created_at', p.created_at)
        order by p.created_at) from payments p join tenancies t on t.id = p.tenancy_id join rooms r on r.id = t.room_id where p.status = 'pending'), '[]'::jsonb),
    'readings', coalesce((select jsonb_agg(jsonb_build_object('bill_id', b.id, 'tenancy_id', b.tenancy_id, 'room_no', r.room_no, 'tenant', t.full_name,
        'month', b.month, 'prev_reading', b.prev_reading, 'new_reading', b.new_reading, 'electricity', b.electricity, 'photo_id', b.reading_photo, 'reading_at', b.reading_at)
        order by b.reading_at) from bills b join tenancies t on t.id = b.tenancy_id join rooms r on r.id = t.room_id
        where b.reading_by is not null and not b.reading_verified and t.status = 'active' and b.kind = 'regular'), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tenancy_id', c.tenancy_id, 'room_no', r.room_no, 'tenant', t.full_name,
        'description', c.description, 'requested', c.requested, 'proof_id', c.proof, 'created_at', c.created_at,
        'bills', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'month', b.month, 'kind', b.kind, 'note', b.note, 'due_date', b.due_date) order by b.month desc, b.due_date desc, b.created_at desc), '[]'::jsonb)
                  from bills b where b.tenancy_id = c.tenancy_id))
        order by c.created_at) from deduction_claims c join tenancies t on t.id = c.tenancy_id join rooms r on r.id = t.room_id where c.status = 'pending'), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'tenancy_id', k.tenancy_id, 'room_no', r.room_no, 'tenant', t.full_name, 'kind', k.kind,
        'title', k.title, 'details', k.details, 'status', k.status, 'owner_note', k.owner_note, 'photo_id', k.photo, 'created_at', k.created_at)
        order by k.created_at) from tickets k join tenancies t on t.id = k.tenancy_id join rooms r on r.id = t.room_id where k.status in ('open','seen','in_progress')), '[]'::jsonb));
end $$;

create or replace function get_attachment(p_token text, p_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare u users; a attachments;
begin
  u := _auth(p_token);
  select * into a from attachments where id = p_id;
  if not found then raise exception 'Photo not found'; end if;
  -- A tenant may open only the photos they sent themselves. Tenant documents (Aadhaar and so on) are for masters only.
  if u.role = 'tenant' and (a.uploaded_by is distinct from u.id or exists (select 1 from tenant_documents d where d.attachment_id = a.id)) then
    raise exception 'You are not allowed to do this';
  end if;
  return a.data;
end $$;

create or replace function export_all(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _owner(p_token);
  perform _log(u.id, 'backup.downloaded', 'Downloaded a backup of all data');
  return jsonb_build_object('exported_at', now(), 'settings', _settings_json(),
    'rooms', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from rooms x),
    'tenancies', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from tenancies x),
    'bills', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from bills x),
    'bill_adjustments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from bill_adjustments x),
    'payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from payments x),
    'deduction_claims', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from deduction_claims x),
    'tickets', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from tickets x),
    'users', (select coalesce(jsonb_agg(_user_json(x)), '[]') from users x),
    -- The list of documents only (title, size, date). The files themselves are not in the backup.
    'tenant_documents', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from tenant_documents x),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from audit_log x));
end $$;
-- =====================================================================
-- PART 6: what a tenant can do. Every function here only ever touches the
-- signed-in tenant's OWN record (found from the sign-in token, never from an input).
-- =====================================================================
create or replace function _my_tenancy(p_user uuid) returns tenancies language sql stable set search_path = public as $$
  select * from tenancies where user_id = p_user order by (status = 'active') desc, start_date desc limit 1 $$;

create or replace function _save_photo(p_user uuid, p_data text) returns uuid language plpgsql set search_path = public as $$
declare aid uuid;
begin
  if p_data is null or p_data = '' then return null; end if;
  if left(p_data, 11) <> 'data:image/' then raise exception 'That file is not a photo'; end if;
  if length(p_data) > 900000 then raise exception 'The photo is too large. Please try a smaller one.'; end if;
  insert into attachments (data, uploaded_by) values (p_data, p_user) returning id into aid;
  return aid;
end $$;

create or replace function tenant_home(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies;
begin
  u := _auth(p_token, array['tenant']);
  t := _my_tenancy(u.id);
  if t.id is null then raise exception 'No room is linked to your login yet. Please ask the owner.'; end if;
  return _tenancy_view(t.id, false) || jsonb_build_object('building', (select building_name from app_settings where id = 1), 'settings', _settings_json());
end $$;

create or replace function submit_reading(p_token text, p_bill uuid, p_reading numeric, p_photo text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies; b bills; aid uuid; units numeric; amt numeric;
begin
  u := _auth(p_token, array['tenant']);
  t := _my_tenancy(u.id);
  select * into b from bills where id = p_bill and tenancy_id = t.id for update;
  if not found then raise exception 'Bill not found'; end if;
  if b.kind <> 'regular' then raise exception 'A meter reading can only be sent for a monthly bill'; end if;
  if t.status <> 'active' then raise exception 'Your tenancy has ended'; end if;
  if b.reading_verified then raise exception 'The owner has already confirmed this reading. Please ask the owner if it needs a change.'; end if;
  if p_reading is null or p_reading < 0 then raise exception 'Enter the meter reading'; end if;
  if p_reading < b.prev_reading then raise exception 'This is lower than the last reading (%). Please check the meter.', b.prev_reading::text; end if;
  aid := _save_photo(u.id, p_photo);
  update bills set new_reading = p_reading, reading_by = u.id, reading_at = now(), reading_verified = false,
         reading_photo = coalesce(aid, reading_photo) where id = b.id;
  perform _recalc_bill(b.id);
  units := p_reading - b.prev_reading; amt := round(units * b.elec_rate, 2);
  perform _notify_staff('reading', 'Meter reading: Room ' || (select room_no from rooms where id = t.room_id),
    t.full_name || ' sent ' || p_reading::text || ' (last ' || b.prev_reading::text || '): ' || units::text || ' units = ' || _inr(amt) || '. Please check.', '#/inbox');
  perform _log(u.id, 'reading.sent', 'Sent the meter reading ' || _n(p_reading) || ' for ' || _bill_label(b.month, b.kind) || ' (last ' || _n(b.prev_reading) || ': ' ||
               _n(units) || ' units, ' || _inr(amt) || ')' || case when aid is not null then ', with a photo' else '' end,
               t.id, jsonb_build_object('bill_id', b.id, 'reading', p_reading, 'previous', b.prev_reading, 'units', units, 'electricity', amt));
  return jsonb_build_object('units', units, 'electricity', amt);
end $$;

create or replace function report_payment(p_token text, p_amount numeric, p_paid_on date, p_method text,
                                          p_reference text default null, p_note text default null, p_proof text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies;
begin
  u := _auth(p_token, array['tenant']);
  t := _my_tenancy(u.id);
  if t.status <> 'active' then raise exception 'Your tenancy has ended. Please contact the owner.'; end if;
  perform _check_payment(p_amount, p_paid_on, p_method);
  if (select count(*) from payments where tenancy_id = t.id and status = 'pending') >= 10 then
    raise exception 'You already have several payments waiting for the owner. Please wait for them to be confirmed.';
  end if;
  insert into payments (tenancy_id, amount, paid_on, method, reference, note, status, submitted_by, by_tenant, proof)
  values (t.id, round(p_amount, 2), p_paid_on, p_method, nullif(trim(p_reference), ''), nullif(trim(p_note), ''), 'pending', u.id, true, _save_photo(u.id, p_proof));
  perform _notify_staff('payment', 'Payment to confirm: Room ' || (select room_no from rooms where id = t.room_id),
    t.full_name || ' says they paid ' || _inr(p_amount) || ' by ' || upper(p_method) ||
    case when nullif(trim(p_reference), '') is not null then ' (ref ' || trim(p_reference) || ')' else '' end || '. Please check and confirm.', '#/inbox');
  perform _log(u.id, 'payment.requested', 'Reported a payment of ' || _inr(p_amount) || ' by ' || _method_name(p_method) ||
               case when nullif(trim(p_reference), '') is not null then ' (ref ' || trim(p_reference) || ')' else '' end || ', paid on ' || _d(p_paid_on) || '. Waiting to be confirmed.',
               t.id, jsonb_build_object('amount', round(p_amount, 2), 'paid_on', p_paid_on, 'method', p_method, 'reference', nullif(trim(p_reference), ''), 'note', nullif(trim(p_note), '')));
end $$;

create or replace function claim_deduction(p_token text, p_description text, p_amount numeric, p_proof text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies;
begin
  u := _auth(p_token, array['tenant']);
  t := _my_tenancy(u.id);
  if t.status <> 'active' then raise exception 'Your tenancy has ended'; end if;
  if coalesce(trim(p_description), '') = '' then raise exception 'Please describe the work you got done'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount you spent'; end if;
  insert into deduction_claims (tenancy_id, description, requested, proof)
  values (t.id, trim(p_description), round(p_amount, 2), _save_photo(u.id, p_proof));
  perform _notify_staff('deduction', 'Deduction request: Room ' || (select room_no from rooms where id = t.room_id),
    t.full_name || ' did maintenance (' || trim(p_description) || ') and asks to subtract ' || _inr(p_amount) || '.', '#/inbox');
  perform _log(u.id, 'claim.requested', 'Asked for a deduction of ' || _inr(p_amount) || ' for maintenance: ' || trim(p_description),
               t.id, jsonb_build_object('amount', round(p_amount, 2), 'description', trim(p_description)));
end $$;

create or replace function create_ticket(p_token text, p_kind text, p_title text, p_details text default null, p_photo text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies;
begin
  u := _auth(p_token, array['tenant']);
  t := _my_tenancy(u.id);
  if t.status <> 'active' then raise exception 'Your tenancy has ended'; end if;
  if p_kind not in ('maintenance','complaint','other') then raise exception 'Choose the type of request'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Please write a short title'; end if;
  insert into tickets (tenancy_id, kind, title, details, photo)
  values (t.id, p_kind, trim(p_title), nullif(trim(p_details), ''), _save_photo(u.id, p_photo));
  perform _notify_staff('ticket', case p_kind when 'complaint' then 'Complaint' when 'maintenance' then 'Maintenance request' else 'Request' end ||
    ': Room ' || (select room_no from rooms where id = t.room_id), trim(p_title), '#/inbox');
  perform _log(u.id, 'ticket.created', 'New ' || case p_kind when 'complaint' then 'complaint' when 'maintenance' then 'maintenance request' else 'request' end || ': ' || trim(p_title),
               t.id, jsonb_build_object('kind', p_kind, 'title', trim(p_title), 'details', nullif(trim(p_details), '')));
end $$;

create or replace function receipt(p_token text, p_payment uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; p payments; t tenancies; led jsonb;
begin
  u := _auth(p_token);
  select * into p from payments where id = p_payment and status = 'approved';
  if not found then raise exception 'Receipt not found'; end if;
  select * into t from tenancies where id = p.tenancy_id;
  if u.role = 'tenant' and t.user_id is distinct from u.id then raise exception 'You are not allowed to do this'; end if;
  led := _ledger(t.id, p.paid_on);
  return jsonb_build_object('building', (select building_name from app_settings where id = 1), 'receipt_no', p.receipt_no,
    'paid_on', p.paid_on, 'amount', p.amount, 'method', p.method, 'reference', p.reference, 'tenant', t.full_name,
    'edited_at', p.edited_at, 'edit_note', p.edit_note, 'phone', case when u.role = 'tenant' then null else t.phone end,
    'room_no', (select room_no from rooms where id = t.room_id),
    'applied', coalesce((select x->'applied' from jsonb_array_elements(led->'payments') x where (x->>'id')::uuid = p.id), '[]'::jsonb),
    'credit_left', coalesce((select x->'credit_left' from jsonb_array_elements(led->'payments') x where (x->>'id')::uuid = p.id), '0'::jsonb),
    'balance_after', led->'totals'->'outstanding', 'credit_after', led->'totals'->'credit');
end $$;
-- =====================================================================
-- PART 7: notifications, reminders, and lock-down of who may call what.
-- =====================================================================
create or replace function my_notifications(p_token text, p_limit int default 40) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _auth(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'link', n.link,
      'created_at', n.created_at, 'read', n.read_at is not null) order by n.created_at desc)
      from (select * from notifications where user_id = u.id order by created_at desc limit least(coalesce(p_limit, 40), 100)) n), '[]'::jsonb);
end $$;

create or replace function mark_notifications_read(p_token text, p_ids uuid[] default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _auth(p_token);
  update notifications set read_at = now() where user_id = u.id and read_at is null and (p_ids is null or id = any (p_ids));
end $$;

create or replace function save_push_subscription(p_token text, p_endpoint text, p_p256dh text, p_auth text, p_device text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _auth(p_token);
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'Invalid subscription'; end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, device) values (u.id, p_endpoint, p_p256dh, p_auth, left(p_device, 200))
  on conflict (endpoint) do update set user_id = u.id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device;
end $$;

create or replace function remove_push_subscription(p_token text, p_endpoint text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _auth(p_token);
  delete from push_subscriptions where user_id = u.id and endpoint = p_endpoint;
end $$;

-- Used only by the delivery function (service role).
create or replace function claim_notifications(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb;
begin
  with c as (
    update notifications n set sent_at = now()
    where n.id in (select id from notifications where sent_at is null order by created_at limit least(p_limit, 200) for update skip locked)
    returning n.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'body', c.body, 'link', c.link, 'kind', c.kind,
      'email', usr.email, 'name', usr.full_name,
      'app_url', (select app_url from app_settings where id = 1), 'app_name', (select building_name from app_settings where id = 1),
      'subs', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
               from push_subscriptions s where s.user_id = c.user_id))), '[]'::jsonb)
  into r from c join users usr on usr.id = c.user_id;
  return r;
end $$;

create or replace function drop_push_subscriptions(p_endpoints text[]) returns void language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = any (p_endpoints) $$;

create or replace function session_ok(p_token text) returns boolean language sql security definer set search_path = public, extensions as $$
  select exists (select 1 from sessions s join users u on u.id = s.user_id
                 where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and s.expires_at > now() and u.active) $$;

-- "Send me a test notification" button (Settings).
create or replace function send_test_notification(p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare u users;
begin
  u := _auth(p_token);
  perform _notify(u.id, 'test', 'Test notification', 'If you can read this on your phone, notifications are working.', '#/', null);
end $$;

-- Runs every morning (see schedule.sql): makes the month's bills, reminders for tenants, and a summary for the owner.
create or replace function generate_reminders(p_today date default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s app_settings; today date; t record; led jsonb; rec record; b jsonb; dd int; late int; lbl text;
  n_over int := 0; amt_over numeric := 0; n_soon int := 0; created int := 0;
begin
  select * into s from app_settings where id = 1;
  today := coalesce(p_today, _today());
  if extract(day from today)::int = s.bill_day then
    created := _create_bills(today);
    if created > 0 then                                     -- one Lodging line, done by nobody ("Automatic")
      perform _log(null, 'bill.auto_created', 'Made ' || created || case when created = 1 then ' bill' else ' bills' end || ' for ' || to_char(today, 'FMMonth YYYY') || ' (daily run)',
                   null, jsonb_build_object('month', date_trunc('month', today)::date, 'count', created));
    end if;
  end if;
  for t in select tn.id, tn.user_id, rm.room_no from tenancies tn join rooms rm on rm.id = tn.room_id where tn.status = 'active' loop
    led := _ledger(t.id, today);
    if (led->'totals'->>'overdue_bills')::int > 0 then
      n_over := n_over + 1; amt_over := amt_over + (led->'totals'->>'overdue_amount')::numeric;
    end if;
    for rec in select x as bj from jsonb_array_elements(led->'bills') x where x->>'status' <> 'upcoming' loop
      b := rec.bj;
      dd := (b->>'due_date')::date - today;
      lbl := _bill_label((b->>'month')::date, b->>'kind');
      if b->>'kind' = 'previous' then
        -- Old dues: no "due in N days" and no meter-reading alerts. Only "still unpaid" on days 1, 3, 7, then weekly.
        late := -dd;
        if (b->>'outstanding')::numeric > 0 and t.user_id is not null and (late in (1, 3, 7) or (late > 7 and late % 7 = 0)) then
          perform _notify(t.user_id, 'overdue', 'Old dues are still unpaid',
            'Old dues of ' || _inr((b->>'principal_left')::numeric) || ' are still unpaid' ||
            case when (b->>'interest_waived')::boolean and (b->>'interest_left')::numeric = 0 then '. Please pay as soon as you can.'
                 else ', plus late interest ' || _inr((b->>'interest_left')::numeric) || ' = ' || _inr((b->>'outstanding')::numeric) ||
                      case when (b->>'interest_waived')::boolean then '.' else '. Interest grows every day until it is paid.' end end,
            '#/home', 'late:' || (b->>'id') || ':' || late);
        end if;
        continue;
      end if;
      if (b->>'outstanding')::numeric > 0 then
        if dd between 0 and 3 then n_soon := n_soon + 1; end if;
        if t.user_id is not null then
          if dd >= 0 and dd = any (s.reminder_days) then
            perform _notify(t.user_id, 'due',
              case when dd = 0 then 'Rent is due today' else 'Rent due in ' || dd || case when dd = 1 then ' day' else ' days' end end,
              lbl || ': ' || _inr((b->>'outstanding')::numeric) || ' to pay by ' || to_char((b->>'due_date')::date, 'DD Mon') || '.', '#/home', 'due:' || (b->>'id') || ':' || dd);
          elsif dd < 0 then
            late := -dd;
            if late in (1, 3, 7) or (late > 7 and late % 7 = 0) then
              perform _notify(t.user_id, 'overdue', 'Rent overdue by ' || late || case when late = 1 then ' day' else ' days' end,
                lbl || ': ' || _inr((b->>'principal_left')::numeric) || ' plus late interest ' || _inr((b->>'interest_left')::numeric) ||
                ' = ' || _inr((b->>'outstanding')::numeric) || '. Interest grows every day until it is paid.', '#/home', 'late:' || (b->>'id') || ':' || late);
            end if;
          end if;
        end if;
      end if;
      if t.user_id is not null and (b->>'awaiting_reading')::boolean and dd = 2 then
        perform _notify(t.user_id, 'reading', 'Please send your meter reading', 'Your bill for ' || lbl || ' needs this month''s electricity meter reading.', '#/home', 'reading2:' || (b->>'id'));
      end if;
    end loop;
  end loop;
  if n_over > 0 or n_soon > 0 or _inbox_count() > 0 then
    perform _notify_staff('digest', 'Daily summary',
      concat_ws(' ', case when n_over > 0 then n_over || (case when n_over = 1 then ' room is' else ' rooms are' end) || ' overdue (' || _inr(amt_over) || ').' end,
                     case when n_soon > 0 then n_soon || (case when n_soon = 1 then ' bill is' else ' bills are' end) || ' due within 3 days.' end,
                     case when _inbox_count() > 0 then _inbox_count() || ' item(s) waiting in your inbox.' end), '#/', 'digest:' || today);
  end if;
  return jsonb_build_object('date', today, 'bills_created', created, 'rooms_overdue', n_over);
end $$;

-- ---------- reminders sent by hand (the Share sheet) ----------
-- 'app' puts ONE alert (phone notification + email) in the tenant's own app: the tenant needs a login, and a second
-- one is refused for 30 minutes. The other channels (whatsapp, sms, share, copy) send nothing from here: the master
-- sends the message from their own phone, and this only notes in Lodging that they opened it.
create or replace function send_reminder(p_token text, p_tenancy uuid, p_channel text default 'app') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; t tenancies; tot jsonb; due numeric; intr numeric; ch text := coalesce(p_channel, 'app'); last_at timestamptz; mins int;
begin
  u := _staff(p_token);
  if ch not in ('app', 'whatsapp', 'sms', 'share', 'copy') then raise exception 'Unknown way of reminding'; end if;
  select * into t from tenancies where id = p_tenancy;
  if not found then raise exception 'Tenant not found'; end if;
  tot := _ledger(t.id)->'totals'; due := (tot->>'outstanding')::numeric; intr := (tot->>'interest_due')::numeric;
  if ch = 'app' then
    if t.user_id is null then raise exception 'This tenant has no login yet, so the app cannot alert them. Use WhatsApp or a text message instead.'; end if;
    if due <= 0 then raise exception 'Nothing is due from this tenant right now.'; end if;
    select max(created_at) into last_at from notifications where user_id = t.user_id and kind = 'reminder';
    if last_at is not null and last_at > now() - interval '30 minutes' then
      mins := greatest(1, ceil(extract(epoch from (last_at + interval '30 minutes' - now())) / 60.0)::int);
      raise exception 'An app alert was already sent to this tenant a short while ago. Please wait % more minute(s).', mins;
    end if;
    perform _notify(t.user_id, 'reminder', 'Payment reminder',
      'A reminder from ' || (select building_name from app_settings where id = 1) || ': ' || _inr(due) || ' is to be paid' ||
      case when intr > 0 then ' (including late interest ' || _inr(intr) || ')' else '' end || '. Please pay as soon as you can.', '#/home');
    perform _log(u.id, 'reminder.app', 'Sent an app alert and email to ' || _who(t.id) || ': ' || _inr(due) || ' to pay', t.id, jsonb_build_object('to_pay', due, 'interest', intr));
  else
    perform _log(u.id, 'reminder.' || ch,
      case ch when 'whatsapp' then 'Opened WhatsApp to remind ' when 'sms' then 'Opened a text message to remind ' when 'share' then 'Opened the share menu to remind ' else 'Copied a reminder message for ' end ||
      _who(t.id) || ' (' || _inr(due) || ' to pay)', t.id, jsonb_build_object('to_pay', due, 'interest', intr));
  end if;
  return jsonb_build_object('channel', ch, 'to_pay', due);
end $$;

-- ---------- Lodging: the list of everything that was done, newest first (masters only) ----------
--   p_limit   how many lines (1 to 200)            p_before  only lines older than this line number ("Show older")
--   p_group   payments | bills | tenants | settings p_tenancy only lines about one tenant (the History tab)
--   p_q       words to look for in the sentence, room, tenant or master name. A first line "room:101" means
--             exactly Room 101; words on the next line are then searched inside that room's lines.
create or replace function lodging_list(p_token text, p_limit int default 50, p_before bigint default null, p_group text default null,
                                        p_tenancy uuid default null, p_q text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u users; lim int := least(greatest(coalesce(p_limit, 50), 1), 200); q text := nullif(trim(coalesce(p_q, '')), ''); room text; pat text; got jsonb;
begin
  u := _staff(p_token);
  if q ~* '^room:' then
    room := trim(split_part(substring(q from 6), chr(10), 1));
    q := nullif(trim(split_part(q, chr(10), 2)), '');
  end if;
  if q is not null then pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor', coalesce(a.actor_name, 'Automatic'), 'actor_role', a.actor_role,
           'action', a.action, 'group', a.group_name, 'summary', a.summary, 'room_no', a.room_no, 'tenant', a.tenant_name,
           'tenancy_id', a.tenancy_id, 'details', a.details) order by a.id desc), '[]'::jsonb)
    into got
  from (select * from audit_log x
        where (p_before is null or x.id < p_before)
          and (nullif(p_group, '') is null or x.group_name = p_group)
          and (p_tenancy is null or x.tenancy_id = p_tenancy)
          and (room is null or x.room_no = room)
          and (pat is null or x.summary ilike pat or x.tenant_name ilike pat or x.actor_name ilike pat or ('Room ' || x.room_no) ilike pat)
        order by x.id desc limit lim + 1) a;
  return jsonb_build_object('rows', case when jsonb_array_length(got) > lim then got - lim else got end, 'more', jsonb_array_length(got) > lim);
end $$;

-- ---------------- lock-down: who may call which function ----------------
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' loop
    if f.proname in ('public_info','login','logout','me','change_password','update_profile','update_settings','staff_users','add_admin',
      'set_user_active','reset_password','create_tenant_login','rooms_overview','room_detail','tenancy_detail','save_room','move_in',
      'save_tenancy','move_out','create_bills','add_bill','billing_month','update_bill','delete_bill','add_adjustment','delete_adjustment',
      'record_payment','decide_payment','void_payment','decide_deduction','update_ticket','inbox','get_attachment','export_all',
      'tenant_home','submit_reading','report_payment','claim_deduction','create_ticket','receipt','my_notifications',
      'mark_notifications_read','save_push_subscription','remove_push_subscription','send_test_notification',
      -- added in version 2 (all for masters only; each checks the sign-in token itself)
      'lodging_list','add_old_dues','building_bill','payments_month','edit_payment','tenant_documents_list',
      'add_tenant_document','delete_tenant_document','send_reminder','storage_info') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname in ('claim_notifications','drop_push_subscriptions','session_ok') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
