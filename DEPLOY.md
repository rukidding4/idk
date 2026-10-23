# Deploying ///AMG to a Permanent Free Web Host

This guide gets your app a **permanent public URL** that works even when the
Daytona sandbox is stopped. You only need a free GitHub account.

The repo is already deployment-ready:
- Server reads the port from `$PORT` (hosts set this automatically)
- `start` script: `node server.js`
- Health check at `/health`
- Config files included: `render.yaml`, `Dockerfile`, `fly.toml`, `Procfile`

> Note: On this sandbox the code is pushed to your GitHub repo automatically.
> Find the repo name under your GitHub account before starting.

---

## Option A — Render (easiest, recommended)

Render has a free tier and reads the included `render.yaml` blueprint.

1. **Create a GitHub account** (if you don't have one): https://github.com/signup
2. Go to https://render.com and click **Get Started** → **Sign in with GitHub** → **Authorize**.
3. In the Render dashboard, click **New +** → **Blueprint**.
4. Pick the **///AMG repository** from the list → click **Connect**.
5. Render detects `render.yaml`. Click **Apply** / **Create Resources**.
6. Wait ~2-3 minutes for the first build. Status turns **Live**.
7. Your permanent URL appears at the top, like:
   `https://your-app.onrender.com`
8. Done — open that URL any time.

### Important about the free tier
- Free services **sleep after 15 minutes** of no traffic.
- The first visit after sleeping takes **~30-60 seconds** to wake up.
- The site then works normally.
- To keep it always awake for free, see **Keep-alive** below.

---

## Option B — Koyeb (free tier, Docker)

1. Sign up at https://www.koyeb.com with GitHub.
2. **Create Service** → **GitHub** → pick the repo.
3. Builder: **Dockerfile** (auto-detected). Port: **3000**.
4. Instance: **Free** → **Deploy**.
5. Your URL looks like `https://<your-app>.koyeb.app`.

---

## Option C — Railway

1. Sign up at https://railway.app with GitHub.
2. **New Project** → **Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects Node and uses the `Procfile` / start script.
4. **Settings → Networking → Generate Domain**.
5. Free trial gives limited monthly hours; then paid.

---

## Option D — Fly.io (Docker, needs a card)

Install the CLI, then:

```bash
fly auth signup        # or: fly auth login
fly launch --no-deploy # accept the existing fly.toml
fly deploy
```

Your URL is `https://your-app.fly.dev`.

---

## Keep-alive (prevent free-tier sleep)

Free hosts sleep when idle. To keep the site always awake, create a free
uptime monitor:

1. Sign up at https://uptimerobot.com (free).
2. **Add New Monitor** → Type: **HTTP(s)**.
3. URL: your health endpoint, e.g. `https://your-app.onrender.com/health`
4. Monitoring interval: **5 minutes**.
5. Save. The monitor pings the site, preventing sleep.

---

## Custom domain (optional, free)

On Render: **Dashboard → your service → Settings → Custom Domains → Add**.
Point your domain's DNS CNAME to the host value Render shows. Free TLS included.

---

## Updating the site

Any push to the deployed branch triggers an automatic redeploy
(`autoDeploy: true` in `render.yaml`). No manual steps needed.

---

## Downloadable apps (served by the site)

Once deployed, the same site also serves the installable apps:
- `https://<your-url>/download` — download page
- `https://<your-url>/download/zip` — Windows portable ZIP
- `https://<your-url>/download/exe` — Windows single .exe
- `https://<your-url>/download/apk` — Android APK

---

## Quick verification

After deploy, open these URLs:
- `/` → the app loads
- `/health` → `{"status":"ok",...}`
- `/api/search?q=queen` → JSON list of songs
