# TM Club 21 – Table Topics Olympics

A live, full-stack web app for running a Toastmasters Table Topics Olympics event.
No database, no WebSockets — pure polling, in-memory state, deploys in minutes.

---

## Quick start (local)

```bash
cd tm-olympics
npm install          # from /server
cp .env.example .env # fill in passwords
node server/index.js
```

Open `http://localhost:3000`.

---

## 1. Populate `questions.yaml`

Edit `questions.yaml` at the repo root. Four stages, each with a `theme` and `questions` list:

```yaml
group_stage:
  theme: "Unexpected Situations"
  questions:
    - "Your question here."
    - "Another question."

quarter_debate:
  theme: "Leadership Dilemmas"
  questions:
    - "..."

semi_final:
  theme: "..."
  questions:
    - "..."

final:
  theme: "..."
  questions:
    - "..."
```

Questions are drawn randomly and marked used — they won't repeat in the same session.

---

## 2. Configure `.env`

Copy `.env.example` to `.env` and fill in both passwords:

```
USER_PASSWORD=your-user-password
ADMIN_PASSWORD=your-admin-password
PORT=3000
```

- `USER_PASSWORD` — shared with all participants and observers
- `ADMIN_PASSWORD` — only for event admins (gives a superset of user access)
- `PORT` — Railway sets this automatically; defaults to 3000 locally

**Never commit `.env` to git.** It is already in `.gitignore`.

---

## 3. Deploy to Railway

### One-time setup

```bash
# Install Railway CLI (if not already)
npm install -g @railway/cli

# Log in
railway login

# From the repo root:
railway init          # creates a new Railway project linked to this directory
railway up            # builds and deploys
```

Railway detects the `Procfile` (`web: node server/index.js`) automatically.

### Set environment variables on Railway

```bash
railway variables set USER_PASSWORD=your-user-password
railway variables set ADMIN_PASSWORD=your-admin-password
```

Or set them in the Railway dashboard under **Variables**.

### Subsequent deploys

```bash
railway up
```

### View logs

```bash
railway logs
```

---

## 4. Custom domain (CNAME)

1. In the Railway dashboard, go to your service → **Settings** → **Networking** → **Custom Domain**.
2. Enter your domain, e.g. `tm21.filzak.dev`.
3. Railway gives you a CNAME target like `<id>.up.railway.app`.
4. In your DNS provider, add a CNAME record:
   - **Name:** `tm21` (or `tm21.filzak.dev` depending on your provider)
   - **Value:** `<id>.up.railway.app`
5. Wait for DNS propagation (usually < 5 min with modern providers).

---

## Architecture notes

- `/server` — Express app (`index.js`), state module (`state.js`), question loader (`questions.js`)
- `/client` — single `index.html` with embedded CSS and JS, served statically by Express
- All API routes prefixed `/api/`
- Auth via `x-password` request header (never exposed in client bundle — validated server-side only)
- Polling: clients `GET /api/state` every 2.5 s; re-render only when `version` increments
- State is **in-memory only** — a server restart resets everything

## Non-goals (out of scope by design)

- No WebSockets
- No database or persistence across restarts
- No individual JWT tokens
- No email / SMS
