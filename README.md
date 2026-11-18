# MJX Labs · Work Ledger

A clean, corporate daily work-log portal built for Render deployment with strict employee privacy isolation and full executive visibility.

## Key Features

- **Strict Employee Privacy Isolation**:
  - Team members sign in with their own private account.
  - Employees **cannot** see each other's names, projects, or work logs—only their own history (`WHERE user_id = current_user`).
  - All isolation is enforced server-side with signed `HttpOnly` session cookies.
- **Executive / Boss Console**:
  - View everyone's logged entries in **Table View** or **Grouped by Person** (great for daily standup reviews).
  - Filter by team member, project, date range (`Today`, `Last 7 Days`, `This Month`, `All Time`), or keyword search.
  - Export filtered logs to CSV (`Name`, `Project`, `Work Done`, `Date & Time`).
  - Manage team access: copy/rotate the Team Invite Code, provision member accounts directly, reset passwords, or disable accounts.
- **4 Core Fields Per Entry** (supports multiple entries per day):
  1. **Person Name** (automatically bound to the authenticated account)
  2. **Project Worked On**
  3. **Work Done**
  4. **Date & Time** (stored in UTC ISO-8601 and displayed in each viewer's local timezone)

---

## Local Development

```bash
npm install
cp .env.example .env   # optional: customize BOSS_EMAIL / TEAM_INVITE_CODE
npm run dev
```

Open `http://localhost:3000`.
- If `BOSS_EMAIL` and `BOSS_PASSWORD` are not set in `.env`, the first visit opens a **One-Time Executive Setup** screen so you can create the Boss account in the browser.
- Local runs automatically store data in `./data/worklog.db` (SQLite) when `DATABASE_URL` is blank.

Run the automated isolation & API test suite:

```bash
npm test
```

---

## Deploying to Render

### Option 1: 1-Click Render Blueprint (`render.yaml`)

1. Push this folder to a GitHub/GitLab repository.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint** and select your repository.
3. Render reads [`render.yaml`](./render.yaml), creates the Node Web Service + PostgreSQL database, and prompts you for:
   - `BOSS_EMAIL` (your boss's login email)
   - `BOSS_PASSWORD` (your boss's initial password)
   - (Optional) customize `TEAM_INVITE_CODE` (defaults to `MJX-TEAM-2026`; the boss can also change this anytime inside **Team & Access**).
4. Once live, share the Render URL and the **Team Invite Code** with your team. Each person clicks **Join Team** to create their own private account.

> **Database note:** Render's free PostgreSQL plan expires after 30 days. For long-term free persistence, you can alternatively create a free PostgreSQL database on Neon or Supabase and paste its `DATABASE_URL` into Render's Environment Variables instead of using Render's free Postgres add-on.

### Option 2: Manual Render Web Service

1. In Render, click **New +** → **Web Service** and connect your repository.
2. Use these settings:
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`
3. Add Environment Variables:
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = *(click Generate)*
   - `DATABASE_URL` = *(your PostgreSQL connection string)*
   - `TEAM_INVITE_CODE` = e.g. `MJX-TEAM-2026`
   - `BOSS_NAME` = e.g. `Internship Lead`
   - `BOSS_EMAIL` = boss login email
   - `BOSS_PASSWORD` = boss password
   - *(Note: If you omit `BOSS_EMAIL`/`BOSS_PASSWORD`, just open the deployed URL right away and complete the one-time Executive Setup form in the browser.)*
