# Northstar PBX — Agent & Admin

Two static apps meant for **separate Vercel projects** and **separate origins**.

| Directory | App        | Vercel “Root Directory” |
| ----------- | ---------- | ------------------------ |
| `agent/`    | Agent phone | `agent`                 |
| `admin/`    | Admin portal | `admin`               |

## Cross-links after deploy

1. Deploy **admin** first, copy its URL (e.g. `https://northstar-admin-xxx.vercel.app`).
2. In `agent/index.html`, set `<meta name="northstar-admin-url" content="PASTE_URL" />`, commit, redeploy agent (or edit in Git and let Vercel rebuild).
3. Deploy **agent**, copy its URL, set `<meta name="northstar-agent-url" content="PASTE_URL" />` in `admin/index.html`, commit, redeploy admin.

The small scripts in each `index.html` wire the top nav links from those meta tags.

## Local preview

```bash
npx serve agent
npx serve admin
```

## GitHub

Push this repo to GitHub, then connect each Vercel project to the same repository with the root directory set as above.
