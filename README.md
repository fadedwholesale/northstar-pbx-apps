# Northstar PBX — Agent & Admin

Two static apps for **separate Vercel projects** (separate origins). This repo is wired for **one GitHub repo** and two Vercel deployments using different **root directories**.

| Directory | App | Vercel “Root Directory” |
| --- | --- | --- |
| `agent/` | Agent phone | `agent` |
| `admin/` | Admin portal | `admin` |

## Live deployments (current)

- **Agent:** [northstar-agent-phone.vercel.app](https://northstar-agent-phone.vercel.app)
- **Admin:** [admin-rho-black-82.vercel.app](https://admin-rho-black-82.vercel.app) (Vercel auto-assigned alias for project `admin`; rename the project or add a custom domain in Vercel for a cleaner URL.)

Cross-links use `<meta name="northstar-admin-url">` and `<meta name="northstar-agent-url">` in each `index.html` (already set to the URLs above). Update those values if your production URLs change.

## Local preview

```bash
npx serve agent
npx serve admin
```

## GitHub + Vercel

Repository: [github.com/fadedwholesale/northstar-pbx-apps](https://github.com/fadedwholesale/northstar-pbx-apps)

Connect each Vercel project to this repo and set **Root Directory** to `agent` or `admin` respectively. Each folder includes `vercel.json` with `outputDirectory: "."` and a no-op `npm run build` so static HTML deploys reliably.
