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
| `id` | Lowercase letters, digits and dashes. It becomes the URL: `/myapp/` and `/#myapp`. Not `api` or `icons`. |
| `repo` | A public git URL. The build clones the default branch on every deploy, so a push to the app's repo reaches the site on the next deploy. |
| `icon` | Path inside the app's repo. |
| `tint`, `wash` | The accent colour and the dark background tint shown while the app is selected. |
| `name`, `kind`, `pitch` | The text on the home screen. |

**Optional fields**

| Field | Meaning |
| --- | --- |
| `files` | What to copy from the repo. Default: `index.html`, `css`, `js`, `assets`. |
| `chips` | Feature tags shown under the pitch. |
| `iconStyle` | Extra CSS for the icon, to nudge one that is off-centre. |
| `ownsEsc` | `true` if the app uses Esc itself. The launcher then leaves Esc to the app. |

### Which apps fit

- **Static web apps** (plain HTML/JS/CSS, no build step) drop straight in. Gridline and Palimpsest are this kind.
- **Apps with a build step** (Vite, React, and so on) need the build output committed to the repo, or a build step added to `build.mjs`. Point `files` at the output folder.
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

The relay only allows GET requests and the paths in the allowlist. It also checks that requests come from this site and rate-limits each visitor (`RELAY_LIMIT_PER_MIN`, default 30).

## Local preview

```sh
node build.mjs
python3 -m http.server 8080 --directory public
```

The relay only runs on Vercel, so apps that need it show their "add your own key" state locally.
