# Cricket Drafts

Your game plus a small server so friends can play together without Claude.

- `public/index.html` is the game (single player works offline, multiplayer talks to the server)
- `server.js` is the whole backend: rooms, live updates, hosting, robots.txt and sitemap.xml. No dependencies, no build step.

## Run it on your computer
    node server.js        # then open http://localhost:3000

## Put it on the internet (free, about 10 minutes)
1. Make a free GitHub account and create a new repository, then upload everything in this folder.
2. Make a free account at render.com, choose **New > Web Service**, connect that repository.
   Render reads `render.yaml`, so just confirm and deploy. You get a link like `https://cricket-drafts.onrender.com`.
3. Send friends the link. One person taps Multiplayer, creates a room and shares the 4-letter code.

Notes on the free plan: the server sleeps after about 15 minutes with nobody on it and takes ~30 seconds to wake on the next visit. Rooms live in memory, so a restart or redeploy clears them. For always-on hosting use Render's paid plan (about $7/month), Railway, Fly.io, or any VPS. The included `Dockerfile` works on all of them.

## Getting found on Google
1. Buy a short domain (e.g. cricketdrafts.com) and attach it in Render's Settings > Custom Domains.
2. Set the environment variable `SITE_URL=https://yourdomain.com` so the canonical link, social previews and sitemap use it.
3. Add the site at search.google.com/search-console and submit `https://yourdomain.com/sitemap.xml`. Do the same at Bing Webmaster Tools.
4. Share it where cricket fans are (Reddit r/Cricket, X, WhatsApp groups). The link preview card (og.png) is already set up.
New sites take days to weeks to appear in search; a domain plus a few links pointing at it speeds that up.

## Settings (environment variables)
- `PORT` default 3000 · `SITE_URL` your public address · `TRUST_PROXY=1` when behind Render/Railway/etc.
- `DATA_DIR` optional folder (needs a persistent disk) to keep rooms across restarts.

## Rules the server enforces
Only the host can change the tournament or start a round; players can only write their own progress; 16 players per room; rooms expire after 12 idle hours; requests are rate limited.
