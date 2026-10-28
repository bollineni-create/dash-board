# bollineni-create launcher

A console-style home screen that opens each app inside the site: https://bollineni-create.vercel.app

- `apps.json`: the list of apps on the shelf.
- `site/index.html`: the launcher page.
- `build.mjs`: pulls each app from GitHub into `public/<id>/` and writes the shelf into the page.
- `api/relay.js`: the server relay that adds API keys to an app's requests.
- `vercel.json`: Vercel config. It runs `node build.mjs` on every deploy, and sets the security headers and caching.

## Using it

- **Choose an app:** swipe the shelf left or right, scroll sideways on a trackpad, use the ← → keys, or tap an icon.
- **Start an app:** Start or Enter. Each app gets its own address (`/#gridline`), so you can link straight to an app.
- **Switch apps while one is open:** swipe the top bar, tap a dot, or use ← →.
- **Go back:** ← Launcher, Esc, or the browser's Back button.
- **Preloading:** the selected app and the apps next to it load in the background, unless the phone is on Data Saver or a slow connection.

## Keeping apps up to date

- **Every app with a `repo`** (all of them: Gridline, Palimpsest, Ballast, Rounds and Loom) follows its repo's default branch. Each app repo has `.github/workflows/notify-dash-board.yml`, which tells this repo about every push to `main`. That starts `.github/workflows/sync-apps.yml`, which writes the app's new commit into `apps.lock.json` and commits it to `main`, and Vercel then deploys `main`. A push to an app reaches the site in a minute or two. The notify step needs a `DASH_BOARD_TOKEN` secret in each app repo (a fine-grained token with *Contents: read and write* on this repo). As a backup, `sync-apps.yml` also checks every app every 5 minutes, though GitHub can run scheduled workflows late or skip them when it's busy. To update right away, start the workflow by hand from the Actions tab (*Sync apps → Run workflow*).
- **Holding an app at a version:** set `commit` in `apps.json` to the commit you want. The site then shows that commit until you change or remove it.
- **Loom** comes from the `web/` folder of its repo (`blank`), next to the SwiftUI app, so a push there that touches `web/` changes the site like any other app.

Vercel has to be connected to this repo (Project → Settings → Git) for a push to `main` to deploy.

## Adding an app

Add an entry to `apps.json`, then deploy. The launcher picks up the new icon, the swipe order, the switcher dots and the app's address automatically.

```json
{
  "id": "myapp",
  "name": "My App",
  "repo": "https://github.com/bollineni-create/myapp.git",
  "files": ["index.html", "css", "js", "assets"],
  "icon": "assets/icon.png",
  "kind": "Short category · tagline",
  "pitch": "One or two sentences shown on the home screen.",
  "chips": ["Feature", "Feature", "Feature"],
  "tint": "#7DD3FC",
  "wash": "#0B2030"
}
```

**Required fields**

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and dashes. It becomes the URL: `/myapp/` and `/#myapp`. Not `api`, `icons` or `legal`. |
| `repo` | A public git URL. The site follows the app's default branch: see [Keeping apps up to date](#keeping-apps-up-to-date). |
| `icon` | Path inside the app's repo. |
| `tint`, `wash` | The accent colour and the dark background tint shown while the app is selected. |
| `name`, `kind`, `pitch` | The text on the home screen. |

**Optional fields**

| Field | Meaning |
| --- | --- |
| `files` | What to copy from the repo. Default: `index.html`, `css`, `js`, `assets`. |
| `root` | The folder in the repo that `files` are relative to, when the page isn't at the top (Ballast uses `public`, Rounds and Loom use `web`). `icon` stays relative to the repo root. |
| `commit` | Hold the app at this commit. Pushes to its repo then don't reach the site until you change or remove it. Ballast and Rounds are held while their Mac and iOS versions are worked on. |
| `branch` | Follow this branch instead of the default one. Use it to try an app's unmerged branch, then remove it. |
| `chips` | Feature tags shown under the pitch. |
| `iconStyle` | Extra CSS for the icon, to nudge one that is off-centre. |
| `ownsEsc` | `true` if the app uses Esc itself. The launcher then leaves Esc to the app. |

### Which apps fit

- **Static web apps** (plain HTML/JS/CSS, no build step) drop straight in. Gridline and Palimpsest are this kind. So is Rounds, whose web version lives in `web/` in its repo.
- **Apps with a build step** (Vite, React, and so on) need the build output committed to the repo, or a build step added to `build.mjs`. Point `files` at the output folder.
- **Apps with their own small server** can keep their page as is and get a function in `api/` for the routes it needs. Ballast is this kind: `api/ballast.js` serves its price and strategy-builder routes by importing Ballast's own modules from `.src/ballast` (the copy the build clones), and `vercel.json` rewrites `/ballast/api/*` to it. Its paper-trading autopilot holds Alpaca keys, so it stays in the Mac app.
- **Native apps** (SwiftUI and the like) need a web version written for them. Keep it in a folder of the app's own repo and point `root` at it, as Loom does with `web/` in `blank`. Loom has `api/loom.js` here for its Claude and link-reading routes.
- **Desktop or local-only apps** (Electron, apps that need the local file system or a local server) have to be ported first. Lodestar stays local for this reason.
- Apps load in a same-origin frame. Avoid `X-Frame-Options: DENY` and full-page redirects to other sites.

### Apps that use paid APIs

Keys never go to the browser. The relay adds them on the server:

1. In `api/relay.js`, add the provider to all three tables:
   - `UPSTREAMS`: the API's base URL.
   - `PATHS`: a regex allowlist of the paths the app may call.
   - `ENV_KEYS`: the name of the environment variable that holds the key.
2. In `vercel.json`, add the provider to the `/api/:provider(visor|autodev)/:path*` rewrite.
3. Add the key in Vercel → Project → Settings → Environment Variables. Never put it in the repo.
4. In the app's `apps.json` entry, add `hostedConfig`:
   ```json
   "hostedConfig": { "global": "myAppConfig", "keys": { "myprovider": "MYPROVIDER_KEY" } }
   ```
   The build writes `hosted-config.js`, which sets `window.myAppConfig.defaultKeys = { myprovider: '__server__' }`. It only does this when that key exists on the server.
5. In the app itself, send requests to `/api/myprovider/...` with the header `x-api-key: __server__`.

Ballast's Claude strategy builder uses `ANTHROPIC_API_KEY` the same way: set it in Vercel and `api/ballast.js` uses it, limited to `BALLAST_GENERATE_LIMIT` builds per visitor per 10 minutes (default 6). Without it, Ballast uses its built-in builder.

Rounds reads Reddit through `api/rounds.js`, because browsers can't read Reddit's JSON from another site. Set `REDDIT_CLIENT_ID` to an "installed app" client id from https://www.reddit.com/prefs/apps and the route signs in app-only through `oauth.reddit.com`, which has higher rate limits. Without it, the route reads Reddit's public JSON. It only reads, checks that requests come from this site, and caches listings for 5 minutes and comments for 15.

Loom keeps your library in your browser (IndexedDB). Only the text of an item goes to `api/loom.js` when Claude organizes it or answers a question, and images and PDFs are sent so Claude can read them. It uses the same `ANTHROPIC_API_KEY`, with the server-side refusal fallback on; without the key, Loom still saves, searches and maps everything, just without summaries, tags or answers. The route also reads the title and text of links you save. It refuses private and local addresses, checks that requests come from this site and rate-limits each visitor.

The relay only allows GET requests and the paths in the allowlist. It also checks that requests come from this site and rate-limits each visitor (`RELAY_LIMIT_PER_MIN`, default 30).

## Local preview

```sh
node build.mjs
python3 -m http.server 8080 --directory public
```

The relay only runs on Vercel, so apps that need it show their "add your own key" state locally.

## Credits

Loom's web version uses [Figtree](https://github.com/erikdkennedy/figtree) and [DM Serif Display](https://github.com/googlefonts/dm-fonts), both under the SIL Open Font License (copies in `web/assets/fonts` in the `blank` repo).
