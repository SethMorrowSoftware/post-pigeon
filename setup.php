<?php
// setup.php — one-time installer.
//
// Steps the user runs:
//   1. Copy config.example.php → config.php and fill in DB credentials.
//   2. Open setup.php in a browser.
//   3. The installer applies schema.sql and prompts for the first admin user.
//   4. After at least one user exists this page just shows status — schema is
//      applied idempotently each visit, so re-running is safe.

declare(strict_types=1);

require_once __DIR__ . '/lib/util.php';

// Render the page outside the JSON helpers — this is the one place we serve HTML.
header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

$messages = [];
$errors = [];
$step = 'unknown';
$db_ok = false;
$schema_applied = false;
$user_count = 0;

if (!pp_config_present()) {
    $step = 'config-missing';
} else {
    require_once __DIR__ . '/lib/db.php';
    require_once __DIR__ . '/lib/auth.php';
    try {
        pp_db(); // forces connection
        $db_ok = true;
    } catch (Throwable $e) {
        $errors[] = 'Database connection failed. Double-check config.php and that the MySQL service is reachable.';
        $step = 'db-failed';
    }

    if ($db_ok) {
        try {
            $r = pp_db_apply_schema();
            $schema_applied = true;
            if (!$r['already_present']) $messages[] = 'Schema created.';
        } catch (Throwable $e) {
            $errors[] = 'Could not apply schema: ' . htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8');
            $step = 'schema-failed';
        }
    }

    if ($schema_applied) {
        $user_count = pp_db_user_count();
        $step = $user_count === 0 ? 'first-user' : 'ready';

        // Handle the "create first admin" form submission. Risk window is small
        // (this branch only runs before any user exists), so a SameSite cookie
        // doesn't help; rely on the Origin/Referer match instead.
        $isPost = ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST';
        $origin = $_SERVER['HTTP_ORIGIN']  ?? ($_SERVER['HTTP_REFERER'] ?? '');
        $host   = $_SERVER['HTTP_HOST']    ?? '';
        $crossOrigin = ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== $host);
        if ($step === 'first-user' && $isPost && $crossOrigin) {
            $errors[] = 'Cross-origin request blocked.';
        } elseif ($step === 'first-user' && $isPost) {
            $email    = trim((string)($_POST['email']    ?? ''));
            $username = trim((string)($_POST['username'] ?? ''));
            $pw       = (string)($_POST['password']      ?? '');
            $pw2      = (string)($_POST['confirm']       ?? '');
            try {
                if ($pw !== $pw2) throw new InvalidArgumentException('Passwords do not match.');
                pp_create_user($email, $username, $pw, /* admin */ true, /* must change */ false);
                $messages[] = 'Admin user created. You can now log in.';
                $step = 'ready';
                $user_count = 1;
            } catch (InvalidArgumentException $e) {
                $errors[] = $e->getMessage();
            } catch (RuntimeException $e) {
                $errors[] = $e->getMessage();
            } catch (Throwable $e) {
                $errors[] = 'Could not create admin: ' . $e->getMessage();
            }
        }
    }
}

function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }
?><!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Post Pigeon · Setup</title>
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<link rel="stylesheet" href="assets/styles.css">
<link rel="stylesheet" href="assets/auth.css">
</head><body class="auth-body">

<main class="auth-card">
  <header class="auth-head">
    <div class="auth-brand">
      <svg viewBox="0 0 28 24" width="26" height="22" aria-hidden="true">
        <path d="M2 15 C5 13 8 13 11 14 L14 9 L17 11 L22 7 L21 13 L25 12 L23 16 L18 19 L12 19 L9 22 L8 19 L5 18 Z" fill="currentColor"/>
        <circle cx="20.2" cy="9.4" r=".7" fill="#0b0c0e"/>
        <path d="M22 7 L25.5 6.2 L23 8.2 Z" fill="#d9a441"/>
      </svg>
      <strong>POST PIGEON</strong>
      <span class="auth-sub">setup</span>
    </div>
  </header>

  <?php if ($errors): ?>
    <div class="auth-flash auth-flash--err">
      <?php foreach ($errors as $e): ?><div><?= h($e) ?></div><?php endforeach; ?>
    </div>
  <?php endif; ?>
  <?php if ($messages): ?>
    <div class="auth-flash auth-flash--ok">
      <?php foreach ($messages as $m): ?><div><?= h($m) ?></div><?php endforeach; ?>
    </div>
  <?php endif; ?>

  <?php if ($step === 'config-missing'): ?>
    <h1 class="auth-title">Step 1 — create config.php</h1>
    <ol class="auth-list">
      <li>Copy <code>config.example.php</code> to <code>config.php</code>.</li>
      <li>Fill in your MySQL host, database name, user, and password.</li>
      <li>Reload this page.</li>
    </ol>
    <p class="muted">Both files live next to <code>index.php</code> in the project root.</p>

  <?php elseif ($step === 'db-failed'): ?>
    <h1 class="auth-title">Database not reachable</h1>
    <p>Open <code>config.php</code> and verify the connection details. On cPanel, the host is almost always <code>localhost</code>.</p>

  <?php elseif ($step === 'schema-failed'): ?>
    <h1 class="auth-title">Could not apply schema</h1>
    <p>The connection worked, but creating tables failed. Make sure the database user has <code>CREATE</code>, <code>INDEX</code>, and <code>REFERENCES</code> privileges on the database.</p>

  <?php elseif ($step === 'first-user'): ?>
    <h1 class="auth-title">Create the first admin</h1>
    <p class="muted">This account can create more users from the admin panel after login.</p>
    <form method="post" class="auth-form" autocomplete="off">
      <label class="field">
        <span class="field-label">Email</span>
        <input type="email" name="email" required value="<?= h($_POST['email'] ?? '') ?>">
      </label>
      <label class="field">
        <span class="field-label">Username</span>
        <input type="text" name="username" required pattern="[A-Za-z0-9_.\-]{3,64}"
               value="<?= h($_POST['username'] ?? '') ?>">
      </label>
      <label class="field">
        <span class="field-label">Password</span>
        <input type="password" name="password" required minlength="<?= (int)pp_config_get('password_min_length', 10) ?>">
      </label>
      <label class="field">
        <span class="field-label">Confirm password</span>
        <input type="password" name="confirm" required minlength="<?= (int)pp_config_get('password_min_length', 10) ?>">
      </label>
      <button class="auth-submit" type="submit">Create admin</button>
    </form>

  <?php elseif ($step === 'ready'): ?>
    <h1 class="auth-title">Setup complete</h1>
    <p>Database is connected, schema is applied, and <?= (int)$user_count ?> user<?= $user_count === 1 ? '' : 's' ?> exist.</p>
    <p class="muted" style="margin-top:8px">For safety, delete <code>setup.php</code> from the server now that you no longer need it. (It is harmless if you leave it — schema is applied idempotently and the form only renders when no users exist.)</p>
    <p style="margin-top:18px">
      <a class="auth-submit auth-submit--link" href="login.html">Continue to login →</a>
    </p>

  <?php else: ?>
    <h1 class="auth-title">Setup</h1>
    <p>Reload the page after fixing the issue above.</p>
  <?php endif; ?>

  <footer class="auth-foot muted">
    Post Pigeon · self-hosted carrier
  </footer>
</main>

</body></html>
