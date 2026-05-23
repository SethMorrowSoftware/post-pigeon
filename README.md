# Post Pigeon

A self-hosted, dark-utilitarian API client. Vanilla HTML/CSS/JS on the front end, a handful of small PHP files on the back end, and MySQL for persistence + multi-user auth. Drop the folder into any `public_html/` on shared cPanel hosting, point it at a MySQL database, and it just works — no build step, no Node, no Docker.

If `proxy.php` is reachable, requests are sent through it as a CORS-bypassing cURL proxy. If not, the UI falls back to the browser's `fetch()` (works for CORS-friendly APIs, blocked for the rest).

---

## Features

- **Multi-user auth** — email/username + password login, bcrypt-hashed credentials, server-side sessions in MySQL, brute-force throttling, `Lax`+`HttpOnly`+`Secure` cookies
- **Admin panel** — admin-only invites: create users with auto-generated temp passwords, promote/demote, disable, delete, force password reset; first user (created via `setup.php`) is automatically admin
- **MySQL workspace storage** — each user's collections, requests, environments, and history live in proper relational tables (`utf8mb4`, foreign keys, `ON DELETE CASCADE`)
- **Request workshop** — method, URL with `{{var}}` substitution, query params, headers, body (none / form-data / x-www-form-urlencoded / raw JSON·XML·HTML·text·JS), auth (none, Basic, Bearer, API Key)
- **Response viewer** — status pill, time, size, pretty / raw / sandboxed-HTML preview with JSON syntax coloring, in-response search, headers table, cookies, real cURL-phase timeline (DNS / TCP / TLS / wait / download)
- **Collections + history** — server-side persistence in MySQL, mirrored to `localStorage` for instant loads. Rename / duplicate / delete from the sidebar; re-saving updates the existing entry instead of creating duplicates.
- **Environments** — multiple sets of `{{vars}}`, switchable from the topbar; live-highlighted in the URL bar. Rename / delete inline.
- **Pre-request scripts + tests** — sandboxed `rb.test()`, `rb.expect()`, `rb.env.set()` helpers
- **Code generator** — cURL, fetch, axios, Python `requests`, PHP cURL, Go `net/http`, raw HTTP
- **Import / export** — paste a `curl` command (supports `-X`, `-H`, `-d`, `--data-urlencode`, `-u`, `--url`, `-A`, `-e`, `-b`, `-k`, `-L`, `--max-time`, ANSI-C `$'…'` quoting, line continuations), paste JSON, or download the whole workspace
- **Tabs survive reload** — your open tabs and their unsaved edits are cached in `localStorage` so a page refresh doesn't drop in-flight work
- **SSRF guard** — by default `proxy.php` refuses to fetch private / loopback / link-local hosts; flip `proxy_allow_private` in `config.php` if you actually need to test internal services
- **Tabs, splitter, keyboard shortcuts** — `⌘↵` send, `⌘S` save, `⌘T` new tab, `⌘W` close, `/` focus search

> **Heads-up — limitations:** the **binary** body mode is UI only (the file picker shows up but a binary file is not yet streamed through the proxy). There is **no built-in cookie jar** — every request is independent. **There is no self-service signup** — by design, only an admin can create accounts.

---

## What gets deployed

```
index.php           # entry point + auth gate
app.html            # single-page UI shell
login.html          # sign-in page
setup.php           # one-time installer (apply schema + create first admin)
auth.php            # login, logout, change-password, current user
api.php             # authenticated workspace CRUD (replaces flat-file storage.php)
admin.php           # admin-only user management endpoints
proxy.php           # cURL proxy (bypasses browser CORS) — auth-gated
config.example.php  # copy → config.php and fill in DB credentials
schema.sql          # MySQL schema (applied automatically by setup.php)
lib/                # PHP modules (db, auth, util) — protected by lib/.htaccess
assets/app.js       # SPA logic
assets/auth.js      # login page logic
assets/styles.css   # dark theme
assets/auth.css     # login + account UI styles
.htaccess           # default doc + denies sensitive files
```

Everything else in the repo (`project/`, `chats/`, `.git`) is reference material — safe to skip when uploading.

---

## Install on cPanel shared hosting

This is the easy path. If you already know how to FTP a folder into `public_html/`, you can skim.

### 1. Download the files

Either:

- Click **Code → Download ZIP** on the GitHub repo and unzip it locally, or
- Run `git clone https://github.com/morroware/post-pigeon.git` if you have git installed.

### 2. Create a MySQL database

In cPanel, open **MySQL Databases** (or **MySQL Database Wizard**). Create:

1. A database, e.g. `youraccount_postpigeon`
2. A database user, e.g. `youraccount_pigeon`, with a strong password
3. Grant **ALL PRIVILEGES** on the database to the user

Write down the hostname (almost always `localhost` on cPanel), database name, username, and password — you'll need them in step 4.

### 3. Upload the project

Sign in to cPanel, open **File Manager**, and navigate to `public_html/`.

You have two reasonable layouts:

- **Subfolder** (recommended) — create `public_html/postpigeon/` and upload into that. URL becomes `https://yourdomain.com/postpigeon/`.
- **Subdomain** — create a subdomain like `pigeon.yourdomain.com` in cPanel (it will create a folder for you), and upload there.

Upload these files/folders:

```
index.php  app.html  login.html  setup.php
auth.php   api.php   admin.php   proxy.php
config.example.php   schema.sql
.htaccess  lib/      assets/
```

> Tip: it's easier to upload the whole project as a single ZIP and use cPanel File Manager's **Extract** action than to upload files one at a time. After extracting you can delete `project/`, `chats/`, `.git/`, and `README.md` if you want a tidy directory.

### 4. Create `config.php` from the template

In File Manager, right-click `config.example.php` and choose **Copy** → save it as `config.php` in the same folder. Open `config.php` in the editor and fill in:

```php
'db' => [
    'host'    => 'localhost',
    'name'    => 'youraccount_postpigeon',
    'user'    => 'youraccount_pigeon',
    'pass'    => 'the password you set in step 2',
    ...
],
```

If your site is served over plain HTTP (e.g. local dev), set `'cookie_secure' => false`. Leave it `true` for any real deployment.

### 5. Make sure `.htaccess` was uploaded

`.htaccess` is a hidden file, and many FTP/upload tools skip hidden files by default. In cPanel File Manager, click **Settings** (top right) and tick **Show Hidden Files (dotfiles)**, then re-check that `.htaccess` is in your project folder **and** in `lib/`. Without these, sensitive files (config, schema, lib modules) could be served directly.

### 6. Verify PHP requirements

Post Pigeon needs:

- PHP 7.4 or newer (any host running PHP 7.4 / 8.x is fine; PDO + bcrypt + JSON are all bundled)
- The **cURL** and **PDO_MySQL** extensions enabled (defaults on every shared host I've tested)

Most cPanel control panels have a **Select PHP Version** or **MultiPHP Manager** tool. Open it, confirm the version is 7.4+, and verify both `curl` and `pdo_mysql` are checked.

### 7. Run the installer

Open `https://yourdomain.com/postpigeon/setup.php` in your browser. The installer will:

1. Verify the MySQL connection
2. Apply `schema.sql` to create the tables (idempotent — safe to re-run)
3. Prompt you to create the first admin account (email + username + password)

Once it shows **Setup complete**, delete `setup.php` from the server (it's harmless if you leave it — the installer only renders the form when no users exist — but deleting reduces attack surface).

### 8. Sign in

Open `https://yourdomain.com/postpigeon/` and log in with the admin you just created. Click your username pill in the top right → **Admin · users…** to invite teammates: enter their email + username, leave the password field empty, and Post Pigeon will generate a one-time password to share with them. They'll be forced to change it on first login.

---

## Manual install (any host with PHP + MySQL + cURL)

The same files work outside cPanel:

```bash
git clone https://github.com/morroware/post-pigeon.git
cd post-pigeon

# 1. Create a MySQL database and a user with privileges on it.
mysql -u root -p -e "CREATE DATABASE postpigeon CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                     CREATE USER 'postpigeon'@'localhost' IDENTIFIED BY 'change-me';
                     GRANT ALL ON postpigeon.* TO 'postpigeon'@'localhost'; FLUSH PRIVILEGES;"

# 2. Copy the config template and fill in credentials.
cp config.example.php config.php
$EDITOR config.php   # edit the 'db' block; set cookie_secure => false for plain http://

# 3. Local smoke-test:
php -S 127.0.0.1:8080
# Open http://127.0.0.1:8080/setup.php and follow the installer.
# After creating the first admin, http://127.0.0.1:8080/ logs you into the app.
```

For Apache: drop the project into your document root. The included `.htaccess` handles the default-doc, denies sensitive files, and `lib/.htaccess` walls off the PHP modules.

For Nginx: `.htaccess` is ignored. Add equivalent rules to your server block:

```nginx
location ^~ /lib/        { deny all; return 403; }
location = /config.php   { deny all; return 403; }
location = /schema.sql   { deny all; return 403; }
location ~* \.json$      { deny all; return 403; }
location / { try_files $uri $uri/ /index.php; }
location ~ \.php$ {
    include fastcgi_params;
    fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
}
```

---

## File map

| File | Role |
|---|---|
| `index.php` | Entry point. Redirects to `setup.php` if unconfigured, `login.html` if not signed in, otherwise serves `app.html`. |
| `login.html` | Sign-in page. POSTs to `auth.php?action=login`. |
| `setup.php` | One-time installer: applies `schema.sql`, prompts for the first admin user. |
| `app.html` | Single-page UI shell. |
| `auth.php` | Login, logout, current-user, change-password endpoints. |
| `api.php` | Authenticated workspace CRUD (collections, requests, environments, history). |
| `admin.php` | Admin-only user management (create, delete, set admin/active, reset password). |
| `proxy.php` | Server-side cURL proxy, gated by session. Restricted to `http(s)://`, body cap 16 MiB, timeout 1–600s. |
| `storage.php` | Deprecated — returns 410 Gone with a pointer to `api.php`. |
| `config.example.php` | Template for `config.php`. The real `config.php` is git-ignored. |
| `schema.sql` | MySQL schema. Applied automatically by `setup.php`. |
| `lib/db.php` | PDO singleton + small query helpers + idempotent schema applier. |
| `lib/auth.php` | Hashing, sessions, throttling, guards (`pp_require_user`, `pp_require_admin`). |
| `lib/util.php` | JSON I/O, config loader, same-origin guard, ID/token primitives. |
| `lib/.htaccess` | Denies every direct request to anything under `lib/`. |
| `assets/app.js` | SPA logic. |
| `assets/auth.js` | Login page logic. |
| `assets/styles.css` | Dark theme. |
| `assets/auth.css` | Login + account/admin UI styles. |
| `.htaccess` | Default doc; denies `*.json`, `config.php`, `schema.sql`. |
| `project/`, `chats/` | Original handoff artifacts from Claude Design — reference only, do not deploy. |

---

## How it works

The whole UI is one HTML file (`app.html`) and one JS file (`assets/app.js`). State lives in a plain JS object and is double-buffered to:

1. `localStorage["postpigeon.v1"]` — instant, survives offline.
2. MySQL via `api.php?resource=workspace` — canonical store, scoped to the signed-in user.

When you click **Send**, the UI POSTs a small JSON envelope to `proxy.php`:

```json
{
  "method": "POST",
  "url": "https://api.example.com/v1/users",
  "headers": [{"name":"Authorization","value":"Bearer …"}],
  "body": "{\"name\":\"Alice\"}",
  "timeout": 30,
  "followRedirects": false,
  "verifySSL": true
}
```

`proxy.php` runs that through cURL and returns:

```json
{
  "status": 201,
  "timeMs": 84,
  "sizeBytes": 142,
  "headers": [...],
  "body": "...",
  "finalUrl": "...",
  "redirects": 0
}
```

Variable substitution (`{{baseUrl}}` etc.) happens in the UI before the envelope is built — `proxy.php` never sees your env vars.

---

## Security notes

- All write endpoints (`api.php`, `auth.php`, `admin.php`, `proxy.php`) require a valid session cookie. Unauthenticated calls receive `401`.
- Passwords are hashed with `bcrypt` (cost 12) via PHP's `password_hash`. Plaintext is never persisted or logged.
- Sessions are 256-bit random tokens stored server-side. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` by default (toggle for plain HTTP only).
- Brute-force throttling: 8 failed login attempts per IP in a 15-minute window triggers a temporary 429.
- Same-origin (Origin/Referer) check on every state-changing request blocks cross-site POSTs even if a cookie leak occurs.
- `proxy.php` only accepts `http://` and `https://` URLs (no `file://`, `gopher://`, etc.) and follows redirects only when you opt in per request, and only to `http(s)://` targets.
- Request/response headers with embedded CR/LF are stripped to defeat header injection.
- The HTML response preview iframe is `sandbox`-ed and `referrerPolicy="no-referrer"` so previewed pages can't run scripts or leak referrers.
- `lib/.htaccess` walls off the PHP modules so they can never be requested directly. The root `.htaccess` denies `config.php`, `schema.sql`, and `*.json`.
- The proxy is auth-gated, which is also a soft-SSRF mitigation — only authenticated users can fire requests through your server.

---

## Troubleshooting

**Status pill says "proxy offline · direct fetch (CORS)"**
The browser couldn't reach `proxy.php`. Open `https://yourdomain.com/postpigeon/proxy.php` directly — you should see `{"error":"Missing url"}`. If you instead see PHP source, your host isn't running PHP for that file (enable PHP for the directory in cPanel). If you get 403/404, re-check that `proxy.php` was uploaded and `index.php` is the default doc.

**"Could not save workspace" toast / saves don't persist**
The MySQL connection probably failed. Open `setup.php` to surface the connection error; check `config.php` and that the DB user has the necessary privileges. The app will keep working from `localStorage` until the server is reachable again.

**`setup.php` shows "Database not reachable"**
Open `config.php` and double-check the host (almost always `localhost` on cPanel), database name, user, and password. On cPanel, the database and user names are typically prefixed with your account, e.g. `youraccount_postpigeon`.

**Login redirects to `/setup.php`**
That happens when the schema isn't applied yet or there are zero users. Run `setup.php` once and create the first admin.

**Saved workspace is overwritten by other tabs**
Same browser, multiple tabs — every tab persists its own `STATE` to MySQL. The last write wins. Open the app in only one tab at a time, or use multiple browser profiles.

**Headers I add in the UI don't appear on the wire**
This was a bug in pre-1.0 builds — the header rows were stored as `{key, val}` but the request builder read `{name, value}`. Pull the latest, refresh the page, and re-save your workspace.

**HTML preview is blank**
Sandboxed iframes can't run scripts, so single-page apps render as their initial server-side HTML only. Switch the response viewer to `pretty` or `raw` to see the full body.

**Binary body mode does nothing**
Known limitation — the UI accepts a file but `proxy.php` doesn't yet stream it. Use `raw` mode with a base64-encoded payload as a workaround.

---

## Development / local hacking

The whole stack is two PHP files plus three static assets. To iterate locally:

```bash
php -S 127.0.0.1:8080
# Edit assets/app.js or assets/styles.css; reload the page.
```

There is no build step. There is no test suite — see `project/CLAUDE.md` for the smoke checklist.

The `project/` and `chats/` folders are the original Claude Design handoff bundle (kept for reference). They contain a duplicate of the deployable files plus the design transcript.

---

## License

MIT.
