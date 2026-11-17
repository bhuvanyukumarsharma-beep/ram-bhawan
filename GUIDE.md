# Ram Bhawan: your step-by-step setup guide

This guide takes you from nothing to a working rent app on your phone. You do not need to know anything technical. You only **copy, paste and click**, and I tell you what you should see after each step.

## What you are setting up

An app for your building, for your phone and your tenants' phones:

- **Rooms** shown as big blocks. Tap a room to see the tenant, what is unpaid, month by month, and the late interest.
- **Rent, water and electricity bills** made the way you work today: fixed rent + ₹100 per person water + (new reading − old reading) × ₹10 − any approved deductions.
- **Payments** in cash, UPI or bank, including part payments, each with a **receipt**. Tenants can say "I have paid" and **you approve it**.
- **Late interest** at 24% a year, counted every day after the due date, on whatever is still unpaid.
- **Alerts** to your phone and email when something needs you, and **reminders to tenants** 5, 3 and 1 days before the due date and on the due date.
- **Maintenance deductions and repair requests** from tenants, which you approve, change or reject.
- **Logins**: you have master access to everything and can add more people with master access. Each tenant sees only their own account.

**Cost: ₹0 a month.** It uses three free services: **Supabase** (keeps your information and sends the reminders), **Netlify** (puts the app on the internet) and **Gmail** (sends the emails). No WhatsApp and no SMS, as you asked. If any website asks you for a card number, stop and do not enter it.

<!-- SCREENSHOTS -->

## Before you start

- **A computer** (laptop or desktop). The setup needs a lot of copy and paste, which is much easier on a computer. After setup you use everything from your phone.
- **Your phone**, to test the alerts.
- **About 60 to 90 minutes** the first time. You can stop after any step and carry on later. This page remembers which steps you ticked "Done" (in the same browser).
- A **notepad file for your secrets**. In Step 3 the setup helper makes it for you. Keep it private, like a bank PIN.

!!! info "How the pieces fit together"
    Think of it as three rooms of one house. **Supabase** is the office where all the records are kept and where the clock rings every morning. **Netlify** is the front door that tenants walk through. **Gmail** is the postman for emails. The **setup helper** (a page in this folder) writes all the little keys and notes that connect them, so you do not have to.

| Step | What you do | Time |
|---|---|---|
| 1 | Create your free database (Supabase) | 10 min |
| 2 | Make a Gmail "app password" for sending emails | 5 min |
| 3 | Run the setup helper | 5 min |
| 4 | Build the database and create your owner login | 5 min |
| 5 | Create the delivery function called `notify` | 5 min |
| 6 | Save the secrets | 5 min |
| 7 | Turn on the daily schedule | 3 min |
| 8 | Put the app on the internet (Netlify) | 10 min |
| 9 | Sign in on your phone and test the alerts | 10 min |
| 10 | Set up your rooms, tenants and old dues | 20 to 30 min |
| 11 | Give tenants their logins | 5 min |

!!! warning "Websites change their screens"
    Supabase, Netlify and Google sometimes rename a button or move a menu. I checked each step against their own help pages, but I could not click through your account myself. If a button has a slightly different name, look for the closest one. If you are stuck, send me the exact words you see on the screen and I will tell you what to press.

---

## Step 1. Create your free database (Supabase)

**What this is:** Supabase keeps all your rooms, tenants, bills and payments safe, and runs the daily reminders.

1. On your computer, go to **supabase.com** and click **Sign in** or **Start your project**. Create an account with your email and a password (or with GitHub or Google if it offers them and you have one). Confirm your email if it asks.
2. Supabase may ask you to create an **organization**. Name it `Ram Bhawan`, choose **Personal** and the **Free** plan, then click **Create organization**.
3. Click **New project** and fill in:
    - **Name:** `ram-bhawan`
    - **Database password:** click **Generate a password** (or type a strong one). **Copy it and keep it.** You will not need it every day, but Supabase may ask for it one day.
    - **Region:** choose **South Asia (Mumbai)**. It is the closest to you, so the app is fast.
    - If you see a choice about the **Data API**, keep it **on**. If you see "automatic RLS", either choice is fine.
4. Click **Create new project** and wait one to three minutes until the project screen appears.
5. Find these two things. **Keep this browser tab open**, you will come back to it many times.
    - **Project URL.** It looks like `https://abcdefghijklmnopqrst.supabase.co`. Look in **Project Settings** (the gear icon at the bottom of the left menu) under **Data API** (or **API**). *If you cannot find it:* look at the address bar of your browser while you are inside your project. It says `supabase.com/dashboard/project/abcdefghijklmnopqrst`. Those 20 letters are your project's name, and the setup helper accepts them on their own.
    - **Publishable key.** It starts with `sb_publishable_`. Look in **Project Settings → API Keys**. If you see no publishable key, click **Create new API Keys** first. On older projects there is a tab called **Legacy API Keys** with an "anon" key that starts with `eyJ`, and that works too.

!!! warning "Never use the secret key"
    The same page also shows a **secret** key (starts with `sb_secret_`, or is called `service_role`). That key can read and change everything. **Never** paste it into the helper or anywhere else in this guide. The publishable key is safe: it is meant to be public, and your data is protected by the rules inside the database.

!!! tip "You should see"
    Your project's home screen, with a menu on the left that includes **SQL Editor** and **Edge Functions**.

---

## Step 2. A Gmail "app password" (for sending emails)

**What this is:** The app sends you an email for every alert, as well as the phone alert. To send emails it needs a special 16-letter password from Google, called an **app password**. It is not your normal Gmail password, so your real password is never stored anywhere.

*You can skip this step and add emails later (see "Adding emails later" at the end). Phone alerts will still work.*

1. **Best:** make a new Gmail address just for this, for example `ramhawan.alerts@gmail.com`. Your own Gmail also works, but a separate one keeps your inbox clean.
2. Sign in to that Gmail, then turn on **2-Step Verification**: go to **myaccount.google.com → Security → 2-Step Verification** and follow the steps (it uses your phone number). Google will not make app passwords without it.
3. Go to **myaccount.google.com/apppasswords** (or search for "App passwords" on your Google Account page). Type the app name `Ram Bhawan` and click **Create**.
4. Google shows a **16-letter password** in four groups, like `abcd efgh ijkl mnop`. **Copy it now. Google shows it only once.** Paste it into a Notepad file for now.

!!! tip "If you cannot find 'App passwords'"
    It means 2-Step Verification is not switched on yet, or the account is a work or school account. Use a normal personal Gmail instead, or skip this step.

A normal Gmail account can send about 500 emails a day. For 15 rooms that is far more than needed.

---

## Step 3. Run the setup helper

**What this is:** A page in this folder that prepares everything you have to paste later: your keys, your owner command, the schedule, and the **website file**. It runs only on your computer. **Nothing you type is sent anywhere.**

1. Open the folder you unzipped. **Double-click `setup-helper.html`.** It opens in your browser.
2. Fill in the form:
    - **A.** Your **Project URL** and **Publishable key** from Step 1.
    - **B.** Your Gmail address and the 16-letter app password from Step 2 (or leave both empty to skip emails).
    - **C.** Your own login for the app: a **login ID** (for example `owner`), your **name**, your **email** (alerts come here) and a **password** you will remember. Use at least 8 characters, with some letters. **Write the password down.**
3. Click **Make my files**. Five boxes appear below.
4. **Right now**, click **Download YOUR-SECRETS.txt** and save it somewhere safe. Then click **Download ram-bhawan-website.zip** and save it in your Downloads or Desktop folder. **Do not open the zip file.**
5. **Keep this helper page open** until you finish Step 8. You will copy things from its boxes in Steps 4, 6, 7 and 8.

!!! warning "If you close the helper page by accident"
    No harm done. Open it again and fill it in again. It makes **new** keys, so use the new boxes from then on. If you had already finished Steps 6, 7 and 8 with the old keys, redo those three steps with the new ones. (Step 4 never needs repeating.)

!!! tip "You should see"
    Five boxes numbered 1 to 5: Secrets, Owner command, Schedule command, Website file, and the Secrets file download.

---

## Step 4. Build the database and create your owner login

**What this is:** You paste the app's database rules into Supabase once, then create your owner account.

1. In Supabase, click **SQL Editor** in the left menu, then **New query** (the **+** button).
2. In the unzipped folder, open **`database.txt`** (it opens in Notepad or TextEdit). Press **Ctrl+A** (Mac: **Cmd+A**) to select everything, then **Ctrl+C** to copy. It is a very long page of text that looks like gibberish. That is normal: it is the rule book of the app.
3. Click in the SQL editor, press **Ctrl+V** to paste, then click **Run** (bottom right). Make sure no text is highlighted when you press Run, otherwise only the highlighted part runs.
    - If Supabase shows a yellow warning about "destructive operations", that is expected: the rule book contains the word "delete" inside the app's own rules. Choose **Run this query**. If it asks any other question, choose the option that runs your query as it is.
4. At the bottom you should see **Success. No rows returned.**
5. Click **New query** again. In the helper page, click **Copy** on box **2 (Your owner command)**. Paste it into the new query and click **Run**.
6. At the bottom you should see: **Owner created. Sign in with ID: owner** (or the ID you chose).

!!! tip "Safe to repeat"
    If you press Run on `database.txt` a second time by mistake, you will see a red message such as "relation already exists". Nothing is changed or lost. Just carry on. If you see "An owner already exists" in the owner step, your owner was already made, which is fine.

!!! warning "A red error that is not 'already exists'?"
    Copy the red message and send it to me. The most common cause is that the paste was cut short, so select everything in `database.txt` again and paste it into a fresh query.

---

## Step 5. Create the delivery function (`notify`)

**What this is:** A small program that sends the phone alerts and the emails. You paste it in once.

1. In Supabase, click **Edge Functions** in the left menu.
2. Click **Deploy a new function**, then choose **Via Editor**.
3. An editor opens with some sample code. Click inside it, press **Ctrl+A**, and press **Delete** so it is empty.
4. In the unzipped folder, open **`notify-function.txt`**, select all, copy, and paste it into the editor.
5. **Name the function exactly `notify`**: all small letters, no spaces. The name appears at the top-left of the editor (it may show a sample name such as `hello-world`). Click it and change it. The name becomes part of the function's internet address, so it matters.
6. Click **Deploy function** at the bottom and wait for the success message.
7. **Switch off "Verify JWT".** Click the function `notify` in the list, then look for a switch called **Verify JWT** (it may be under a tab called **Details**, or in a settings area of the function). Turn it **off** and press **Save** if a save button appears.

!!! info "Why switch it off?"
    Supabase's own gate expects a different kind of login than the one this app uses. The app checks every request itself (with your schedule's secret code, or a signed-in session), so Supabase's gate only gets in the way.

!!! warning "Check this switch again whenever you re-deploy"
    People have reported that this switch can turn itself back on after a re-deploy. If alerts ever stop working after you change the function, look at this switch first. If you cannot find it at all, carry on. In Step 9 the **Send a test alert** button will tell you in plain words if Supabase is blocking the app.

---

## Step 6. Save the secrets

**What this is:** The function needs a few private notes (secret codes and your Gmail details). Supabase keeps them hidden.

1. In Supabase, go to **Edge Functions → Secrets** (the page may be called **Edge Function Secrets**).
2. Add the secrets from box **1 (Secrets for Supabase)** in the helper. Choose whichever way works for you:
    - **Quick way:** in the helper click **Copy all lines**. In Supabase click in the first **Key** box and **paste**. Supabase may spread the lines into separate rows by itself.
    - **If everything lands in one box:** clear it. In the helper open **Table with one Copy button per item**. For each row, click **Copy name**, paste into **Key**, click **Copy value**, paste into **Value**, then click **Add another**.
3. Click **Save**.

!!! tip "You should see"
    A list with these names: `CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and (if you gave Gmail details) `GMAIL_USER` and `GMAIL_APP_PASSWORD`. The values are hidden after saving. That is normal.

Do not add any secret whose name starts with `SUPABASE_`. Supabase supplies those itself and rejects yours.

---

## Step 7. Turn on the daily schedule

**What this is:** This is the clock. Every morning at **8:00 AM India time** it makes the month's bills (on your bill day) and queues the reminders. Every **10 minutes** it sends any alerts that are waiting.

1. In Supabase open **SQL Editor → New query**.
2. In the helper, click **Copy** on box **3 (Schedule command)**. Paste it into the query and click **Run**.
3. At the bottom you should see a small table with **two rows**: `rb-deliver` and `rb-morning`, both with `active` = true.

!!! tip "If you see an error about 'pg_cron', 'pg_net' or 'extension'"
    Go to **Database → Extensions** in Supabase, switch on both **pg_cron** and **pg_net**, then run the same command again.

---

## Step 8. Put the app on the internet (Netlify)

**What this is:** Netlify is where the app's pages live, so you and your tenants can open it from any phone.

1. Go to **netlify.com** and **sign up** (free, with your email or Google). Confirm your email if it asks. Choose the **Free** plan. No card should be needed.
2. Go to **app.netlify.com/drop**.
3. **Drag the file `ram-bhawan-website.zip`** (from Step 3) onto the drop area. Do not unzip it first.
4. Wait about 20 seconds. Netlify shows your new site, with an address like `https://some-random-name-12345.netlify.app`.
5. **Make the site public. This is important.** New Netlify sites start **private**, which means your tenants would see a Netlify "no access" page instead of the app. Click **Make public** (it appears after the first successful publish). *Or:* open the project, then **Project configuration → General → Visitor access → Project visibility**, choose **Public** and **Save**.
6. *(Optional)* Give it a friendlier address, such as `ram-bhawan-sharma.netlify.app`. Netlify lets you change the project name when you press **Make public**, and also under **Project configuration → General**.
7. **Test it as a stranger would.** Open your site's address in a **private or incognito window** (or on your phone, where you are not signed in to Netlify). You should see the **Ram Bhawan sign-in page**.
8. Write the address in your YOUR-SECRETS.txt file.

!!! warning "If you see a Netlify page about access, or a password box"
    The site is still private. Repeat step 5.

!!! info "Updating the app later"
    If I ever send you a new version, open your project on Netlify, go to **Deploys**, and drag the new zip onto the area that says to drop your project folder. The address stays the same. Each upload uses a little of Netlify's free monthly allowance (about 20 uploads a month fit), so there is no need to upload more than you must.

---

## Step 9. Sign in on your phone and test the alerts

1. On your **phone**, open your app's address. Use **Chrome** on Android or **Safari** on iPhone. Sign in with the ID and password from Step 3. You should see a welcome checklist.
2. **Put the app on your Home screen**, so it works like a real app and so alerts can reach you:
    - **Android (Chrome):** tap the **⋮** menu, then **Install app** or **Add to Home screen**.
    - **iPhone (Safari only):** tap the **Share** button, then **Add to Home Screen**, then **Add**. **Open the app from the new icon from now on.** On an iPhone, alerts work only from that icon (it needs iOS 16.4 or newer).
3. Sign in again if asked. Tap **Settings** (bottom right). In the card **Alerts on this phone**, tap **Switch on phone alerts** and choose **Allow** when your phone asks.
4. Tap **Send a test alert**.

!!! tip "You should see"
    A green message such as "Test sent: 1 phone alert sent and 1 email sent". Within a minute your phone shows **Test notification**, and an email arrives (look in **Spam** the first time and mark it "Not spam").

If you see a **warning** instead, the app tells you what is wrong in plain words. Look it up in **Troubleshooting** below. The three most common are:

- *"The delivery function was not found"* → Step 5, the name must be exactly `notify`.
- *"Supabase is blocking the app…"* → Step 5, switch **Verify JWT** off.
- *an email problem* → Step 2, the app password, or Step 6, the Gmail secrets.

**Two checks that the clock is working**

- About 10 minutes after Step 7, run this in the Supabase SQL Editor. The latest rows should say `succeeded`:

    ```sql
    select j.jobname, d.status, d.return_message, d.start_time
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    order by d.start_time desc limit 10;
    ```
- Tomorrow around 8 AM you should get a **Daily summary** alert if anything is overdue, due soon, or waiting in your inbox.

---

## Step 10. Set up your rooms, tenants and old dues

Open the app on your phone (or computer). Tap **Settings** first.

### 10a. Your rules (Settings → Rates and rules)

Check that these match how you work, then tap **Save**:

- **Building name**
- **Your UPI ID.** Tenants see it on their screen with a Copy button, so they know where to pay.
- **Water per person (₹):** 100 · **Electricity per unit (₹):** 10
- **Late interest (% per year):** 24 · **Days before interest starts:** 0 (so interest starts the day after the due date)
- **Make bills on day:** the day of the month when the new bills are made (1 is the default)
- **Remind tenants (days before):** `5, 3, 1, 0` (days before the due date, and the due date itself)

### 10b. Add all your rooms at once

On the **Rooms** screen tap **Add all my rooms** and type one room per line: `room number, floor, usual rent`. For example:

```
101, 1, 4000
102, 1, 3500
201, 2, 5000
```

Check the list that appears, then tap the button that says **Add 3 rooms** (the number is how many you typed). Your rooms appear as big blocks. **Green** means paid up, **amber** means rent is due soon, **red** means overdue, and **grey** means the room is empty (or no bill has been made yet).

### 10c. Move each tenant in

Tap a room, then **Move a tenant in**. Fill in the **Full name**, **Phone**, **Email** (so they also get email reminders), **Monthly rent**, **People living there** (water is charged per person), **Rent due on day**, and **Moved in on**.

**Electricity meter reading now.** This is the "previous reading" for the first bill you make. For a tenant already living there, use the meter reading from the end of the last month that is **fully paid**. If you do not know it, use today's reading and begin billing from this month.

Keep **Create the tenant's login now** ticked, and tap **Save tenant**. A screen shows the tenant's **login ID and password** and a ready-made message. Tap **Copy message** and paste it into your own WhatsApp or SMS chat with the tenant. **The password is shown only at that moment**, so send it before you tap **Done**. (If you miss it, open the tenant and use **Reset password** to make a new one.)

### 10d. Enter old unpaid months (the main reason for this app)

For a tenant who has not paid for some months:

1. Open the room and tap **+ Add a bill**. Pick the **oldest unpaid month** and tap **Create bill**.
2. Open that bill and tap **Edit bill**. Enter that month's **new meter reading** (and the rent or number of people if they were different then). The electricity and the total are worked out for you.
3. Repeat for each unpaid month, oldest first.
4. Record anything the tenant **did pay**: tap **+ Record payment**, enter the amount, the **date they actually paid**, and cash / UPI / bank. The app gives each payment a **receipt number** automatically.

**Interest is counted from each bill's own due date**, so a tenant who missed two months sees interest on both, growing every day until it is paid.

### 10e. Testing first, then starting fresh

Since you are testing in your own account, feel free to add a test room and a made-up tenant, and press every button. When you are happy and want to begin with your real data, you can wipe all the test data in one go:

1. In Supabase open **SQL Editor → New query**, paste this exact line and **Run**:

    ```sql
    select wipe_everything_except_owner('yes, delete all rooms, tenants and payments');
    ```

2. It deletes **all rooms, tenants (and their logins), bills, payments, requests and alerts**. It **keeps** your owner login, anyone you added with master access, and your settings. Receipt numbers start again at 1.

!!! warning "Only do this when you really mean it"
    There is no undo. Once real tenants are in the app, never run this line. (Before big changes, download a backup. See "Backup" below.)

---

## Step 11. Give tenants their logins

Each tenant gets their own login ID and password (from Step 10c) and sees **only their own account**: their bills month by month, what is pending, their payments and receipts, and their own details.

Send each tenant the ready-made message from the app, plus these few lines:

> Please open the link on your phone and sign in. Tap **Add to Home screen** so it works like an app, and in **Me** switch on **Alerts on this phone**. Each month, send your electricity meter reading in the app. After you pay, tap **I have paid** and type the amount and your UPI reference. You can also ask for a repair, or ask for a deduction if you paid for a repair yourself.

!!! info "What tenants can and cannot do"
    **They can:** see their own bills and receipts, send the meter reading, report a payment, ask for a maintenance deduction, send repair requests and complaints, and change their own phone, email and password. **They cannot:** see any other tenant or any owner screen, approve anything, or change any bill. Even if a tenant types an owner page's address, the database itself refuses.

---

## Using the app every day

**Your alerts tell you when something needs you.** Open the app and tap **Inbox** (the number on it counts what is waiting). In the Inbox you can:

- **Confirm** a payment the tenant reported, after you have checked your UPI or bank app. You can change the amount first, or **Reject** it. The tenant gets a receipt and an alert.
- **Approve** a maintenance deduction (you can type a smaller amount) or reject it. The approved amount is subtracted from the bill and shown as a line on it.
- **Check a meter reading** the tenant sent (tap **Looks right**, or correct it).
- **Mark repair requests** as seen, in progress or done, with a note the tenant can read.

**When a tenant pays you in cash:** open the room, tap **+ Record payment**, enter the amount and choose **Cash**. A receipt is made at once. Part payments are fine: the rest stays pending.

**Each month** the app makes everyone's bill on your bill day and asks tenants for their meter reading. Tap **Billing** to see every room for a month on one screen. If a tenant does not send a reading, open the bill and enter it yourself with **Edit bill**.

**To add your own deduction or an extra charge** to a bill, open it and tap **+ Deduction / charge**. Choose *Deduction* (subtracts) or *Extra charge* (adds).

**If a tenant asks for the interest to be dropped** for one month, open that bill, tap **Edit bill** and tick **Do not charge late interest on this bill**. You can untick it again at any time.

**To add someone with master access** (a family member, for example): **Settings → People with master access → + Add a person with master access**. They see and can change everything, so only add someone you fully trust. You can switch a person off and on at any time. Only you, the owner, can add or switch off people.

## How the money is worked out

- **Bill for the month** = fixed rent + water (₹100 × people) + electricity ((new reading − old reading) × ₹10) − approved deductions (+ any extra charge you added).
- **Late interest** = unpaid amount × 24% ÷ 365, for **each day after the due date**. It is **simple** interest, so interest never earns more interest. Example: ₹5,000 unpaid for 30 days late is ₹5,000 × 0.24 ÷ 365 × 30 = **₹98.63**.
- **When money comes in**, it goes to the **oldest bill first**, and inside a bill to **interest first, then the bill itself**. Money paid before a bill exists is kept as advance credit.
- **Only payments you have approved count.** A payment waiting in your Inbox does not reduce anyone's dues yet.
- If you change the interest rate in Settings, unpaid bills are worked out again with the new rate. The water and electricity rates are saved into each bill when it is made, so changing them only affects **future** bills.

!!! info "A word about charging interest"
    Charging late interest on rent is normally something you agree with the tenant in the rent agreement. If yours does not mention it, it is a good idea to add it, and to tell tenants about it. This is general advice and not legal advice.

## Keep your data safe

- **Download a backup every month.** Open **Settings → Backup → Download backup** and keep the file somewhere safe, such as a private folder in Google Drive. The free Supabase plan does not give you a downloadable backup of its own. The backup file has no passwords in it.
- **Open the app at least once a week.** Supabase pauses **free** projects that nobody has used for a week. If it ever happens, you get an email from Supabase first. Open Supabase, choose your project and click **Resume project**. Your data is kept (Supabase keeps a paused project for up to a year).
- **Never share** your YOUR-SECRETS.txt file or the Supabase **secret** key.
- **Passwords** are stored scrambled, so nobody (not even I) can read them. After 5 wrong tries a login is locked for 10 minutes.

## Troubleshooting

??? note "I forgot my owner password"
    In Supabase open **SQL Editor → New query**, and run this (type your new password instead of the words between the quote marks, and do not put any quote mark inside the password):

    ```sql
    select reset_owner_password('my-new-password-here');
    ```

    Then sign in with the new password.

??? note "The app says 'Almost there' or 'Cannot reach the server'"
    The website was not connected to your database. Open the setup helper, check the Project URL and publishable key, press **Make my files**, download the new website zip, and upload it again (Step 8). Check that you used the **publishable** key and the Project URL that ends in `.supabase.co`.

??? note "The app says 'The database is not set up yet'"
    Step 4 was not completed, or the database is still starting up. Wait a minute and refresh. If it stays, repeat Step 4.

??? note "Test alert says the function was not found (404)"
    In Supabase → Edge Functions the function must be named exactly `notify`. If it has another name, create it again with the right name (Step 5).

??? note "Test alert says Supabase is blocking the app (401 or JWT)"
    In Supabase → Edge Functions → `notify`, find **Verify JWT** and switch it **off**, then try again (Step 5).

??? note "Test alert says 'missing its Supabase settings'"
    In Supabase → **Project Settings → API Keys**, copy the **secret** key. In **Edge Functions → Secrets**, add one secret named `RB_SECRET_KEY` with that key as the value. This is the one time you use the secret key, and it goes only into Supabase's secret box, never anywhere else.

??? note "Emails do not arrive, or the test says an email problem"
    Check your spam folder. Then check in Supabase → Edge Functions → Secrets that `GMAIL_USER` is the exact Gmail address and `GMAIL_APP_PASSWORD` is the 16-letter app password with **no spaces** (Step 2). If the Gmail account's 2-Step Verification was turned off, the app password stops working: turn it on again and make a new app password.

??? note "Phone alerts do not arrive"
    On Android, check that notifications are allowed for the app (phone Settings → Apps → the app or Chrome → Notifications) and that battery saver is not stopping it. On iPhone, the app must be opened **from the Home Screen icon**, and iOS must be 16.4 or newer. In the app, **Settings → Alerts on this phone** should say **Phone alerts are on for this phone**. Tap **Send a test alert**.

??? note "Nothing is sent in the morning, or the schedule seems stuck"
    Run the check from Step 9 (the `cron.job_run_details` query). If it shows errors, open **Database → Extensions** and make sure **pg_cron** and **pg_net** are on, then run the schedule command from the helper again (it is safe to run more than once). To see what the delivery function answered, run this:

    ```sql
    select status_code, content, error_msg, created from net._http_response order by created desc limit 5;
    ```

??? note "My tenants see a Netlify page that says they have no access"
    The site is still private. Netlify → your project → **Project configuration → General → Visitor access → Project visibility** → **Public** → Save (Step 8).

??? note "A tenant cannot sign in"
    Open the room, then the **Tenant** tab, then **Reset password / switch off**, and set a new password. Check that the login is not switched off. After 5 wrong tries the tenant must wait 10 minutes.

??? note "Adding emails later"
    In Supabase → Edge Functions → Secrets, add `GMAIL_USER` (the Gmail address) and `GMAIL_APP_PASSWORD` (the 16 letters, no spaces). Then press **Send a test alert** in the app.

## What has been tested, and what has not

I want to be straight with you about this.

**Tested in my own workshop (all passed):**

- The money rules: 300 random situations (late payments, part payments, advance payments, waived interest) checked against a second, independent calculation.
- Who can see what: tenants cannot reach any owner function or anyone else's receipts, even by trying; the only things the internet can ask the database to do are the ones the app itself uses.
- Every screen for owner, admin and tenant, in a phone-size browser, against a real PostgreSQL database: sign-in, rooms, moving in, bills, deductions, payments, receipts, inbox, billing, settings, password changes, lock-outs.
- The phone-alert encryption and signing, checked with an independent decoder, and the email wording and links.
- The setup helper: the keys it makes, the commands it writes (including names with apostrophes), and the website zip it builds.

**Not tested against the real services**, because I cannot sign in to your accounts: Supabase's dashboard screens (I followed Supabase's own help pages), sending a real Gmail, a real push message through Google and Apple, the daily clock on a real Supabase project, and Netlify. That is exactly why the app has a **Send a test alert** button and why this guide has a Troubleshooting part. **If any step does not match what you see, tell me the exact words on the screen and I will fix it with you.**

## What is not in this version

- **No WhatsApp or SMS** (your choice, to avoid cost). Alerts go to phones and email only. You send each tenant their first login by yourself, from your own WhatsApp.
- **No expense or profit tracking** (for example your repair costs or property tax). I mentioned this as a possible later addition. It is **not built**.
- **No online payment.** Tenants pay you by cash, UPI or bank as today. They tell the app, and you approve once you have seen the money arrive. The app cannot see your bank account.
- **Security deposits** are recorded as a number on the tenant's record. The app does not calculate refunds.
- **One building** only.
