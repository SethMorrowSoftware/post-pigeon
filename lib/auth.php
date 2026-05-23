<?php
// lib/auth.php — registration, login, sessions.

declare(strict_types=1);

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/db.php';

/**
 * Hash a plaintext password using bcrypt. Cost 12 is a reasonable balance for
 * shared hosting (~250 ms on a modest core). Bumped from PHP's default 10.
 */
function pp_password_hash(string $plain): string {
    return password_hash($plain, PASSWORD_BCRYPT, ['cost' => 12]);
}

/**
 * Check a plaintext password against a stored hash. Constant-time via PHP.
 */
function pp_password_verify(string $plain, string $hash): bool {
    return password_verify($plain, $hash);
}

/**
 * Validate a candidate password. Returns null on OK or a human-readable
 * complaint string on failure. Kept minimal: length only. Composition rules
 * push users to predictable patterns; length is what matters.
 */
function pp_validate_password(string $p): ?string {
    $min = (int)pp_config_get('password_min_length', 10);
    if (strlen($p) < $min) return "Password must be at least {$min} characters.";
    if (strlen($p) > 1024) return 'Password is too long.';
    return null;
}

/**
 * Create a new user. Throws on conflict / bad input. Returns the new user id.
 */
function pp_create_user(string $email, string $username, string $password, bool $isAdmin = false, bool $mustChangePassword = false): int {
    $email = strtolower(trim($email));
    $username = trim($username);
    if (!pp_is_email($email))    throw new InvalidArgumentException('Invalid email address.');
    if (!pp_is_username($username)) throw new InvalidArgumentException('Username must be 3–64 chars: letters, numbers, "_.-".');
    $pwErr = pp_validate_password($password);
    if ($pwErr) throw new InvalidArgumentException($pwErr);

    $hash = pp_password_hash($password);
    try {
        pp_db_exec(
            'INSERT INTO users (email, username, password_hash, is_admin, must_change_password)
             VALUES (?, ?, ?, ?, ?)',
            [$email, $username, $hash, $isAdmin ? 1 : 0, $mustChangePassword ? 1 : 0]
        );
    } catch (PDOException $e) {
        $code = is_array($e->errorInfo ?? null) ? ($e->errorInfo[1] ?? 0) : 0;
        if ((int)$code === 1062) {
            throw new RuntimeException('Email or username already in use.');
        }
        throw $e;
    }
    return (int)pp_db()->lastInsertId();
}

/**
 * Look up a user by email OR username (login form accepts either).
 * @return array<string,mixed>|null
 */
function pp_find_user_by_login(string $login): ?array {
    $login = strtolower(trim($login));
    return pp_db_one(
        'SELECT * FROM users WHERE (LOWER(email) = ? OR LOWER(username) = ?) LIMIT 1',
        [$login, $login]
    );
}

function pp_find_user(int $id): ?array {
    return pp_db_one('SELECT * FROM users WHERE id = ? LIMIT 1', [$id]);
}

/* ---------------- throttle / brute-force protection ---------------- */

function pp_throttle_record(string $ip, ?string $email, bool $succeeded): void {
    pp_db_exec(
        'INSERT INTO auth_throttle (ip_address, email, succeeded) VALUES (?, ?, ?)',
        [$ip, $email !== null ? strtolower($email) : null, $succeeded ? 1 : 0]
    );
}

function pp_throttle_blocked(string $ip): bool {
    $max    = (int)pp_config_get('login_max_attempts', 8);
    $window = (int)pp_config_get('login_window_seconds', 900);
    if ($max <= 0) return false;
    $row = pp_db_one(
        'SELECT COUNT(*) AS n FROM auth_throttle
          WHERE ip_address = ?
            AND succeeded = 0
            AND attempted_at >= (UTC_TIMESTAMP() - INTERVAL ? SECOND)',
        [$ip, $window]
    );
    return ((int)($row['n'] ?? 0)) >= $max;
}

function pp_throttle_cleanup(): void {
    // Keep a week of attempts; older rows are useless.
    pp_db_exec('DELETE FROM auth_throttle WHERE attempted_at < (UTC_TIMESTAMP() - INTERVAL 7 DAY)');
}

/**
 * Trigger cleanups on roughly 1/N requests so the throttle + sessions tables
 * don't grow unboundedly on long-running deployments. Cheap: random() short-
 * circuits before any DB work.
 */
function pp_maybe_gc(int $oneIn = 50): void {
    if (random_int(1, max(1, $oneIn)) !== 1) return;
    try {
        pp_throttle_cleanup();
        pp_session_cleanup();
    } catch (Throwable $e) {
        // GC failures are non-fatal — log and move on.
        error_log('post-pigeon: gc failed: ' . $e->getMessage());
    }
}

/* ---------------- sessions ---------------- */

function pp_session_cookie_name(): string {
    return (string)pp_config_get('session_cookie', 'pp_session');
}

function pp_session_set_cookie(string $token, int $expiresAt): void {
    $secure = (bool)pp_config_get('cookie_secure', true);
    setcookie(pp_session_cookie_name(), $token, [
        'expires'  => $expiresAt,
        'path'     => pp_cookie_path(),
        'secure'   => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function pp_session_clear_cookie(): void {
    $secure = (bool)pp_config_get('cookie_secure', true);
    setcookie(pp_session_cookie_name(), '', [
        'expires'  => time() - 3600,
        'path'     => pp_cookie_path(),
        'secure'   => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/**
 * Cookie path = directory containing the app, so a /postpigeon/ subfolder
 * deployment doesn't leak the cookie to siblings.
 */
function pp_cookie_path(): string {
    $script = $_SERVER['SCRIPT_NAME'] ?? '/';
    $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
    return $dir === '' ? '/' : $dir . '/';
}

/**
 * Create a new session for the user. Returns [token, expiresAt].
 *
 * @return array{0:string,1:int}
 */
function pp_session_create(int $userId): array {
    $ttl = (int)pp_config_get('session_ttl_seconds', 60 * 60 * 24 * 30);
    $token = pp_random_token(32);
    $expiresAt = time() + $ttl;
    pp_db_exec(
        'INSERT INTO sessions (token, user_id, expires_at, ip_address, user_agent)
         VALUES (?, ?, FROM_UNIXTIME(?), ?, ?)',
        [$token, $userId, $expiresAt, pp_client_ip(), pp_user_agent()]
    );
    pp_session_set_cookie($token, $expiresAt);
    return [$token, $expiresAt];
}

/**
 * Look up the current session from the cookie, refresh expiry, return user.
 * Returns null if there's no valid session.
 *
 * @return array<string,mixed>|null
 */
function pp_current_user(): ?array {
    static $cached = false;
    static $user = null;
    if ($cached) return $user;
    $cached = true;

    $token = $_COOKIE[pp_session_cookie_name()] ?? '';
    if ($token === '' || strlen($token) !== 64 || !ctype_xdigit($token)) {
        return $user;
    }
    $row = pp_db_one(
        'SELECT u.*
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > UTC_TIMESTAMP() LIMIT 1',
        [$token]
    );
    if (!$row || (int)$row['is_active'] !== 1) {
        return $user;
    }
    $user = $row;

    // Sliding window: refresh expiry every time the session is consulted, but
    // only if it's been more than ~5 minutes since last refresh — saves a
    // write on every request.
    $ttl = (int)pp_config_get('session_ttl_seconds', 60 * 60 * 24 * 30);
    pp_db_exec(
        'UPDATE sessions SET expires_at = FROM_UNIXTIME(?)
          WHERE token = ?
            AND expires_at < FROM_UNIXTIME(?)',
        [time() + $ttl, $token, time() + $ttl - 300]
    );
    pp_session_set_cookie($token, time() + $ttl);
    return $user;
}

function pp_logout_current(): void {
    $token = $_COOKIE[pp_session_cookie_name()] ?? '';
    if ($token !== '') {
        pp_db_exec('DELETE FROM sessions WHERE token = ?', [$token]);
    }
    pp_session_clear_cookie();
}

/**
 * Drop expired sessions. Called opportunistically on login.
 */
function pp_session_cleanup(): void {
    pp_db_exec('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()');
}

/* ---------------- guards used by API entry points ---------------- */

/**
 * Return the current user or send a 401 and exit.
 *
 * @return array<string,mixed>
 */
function pp_require_user(): array {
    $u = pp_current_user();
    if (!$u) pp_json_error(401, 'Not authenticated');
    pp_maybe_gc();
    return $u;
}

/**
 * Like pp_require_user, but also enforces is_admin = 1.
 *
 * @return array<string,mixed>
 */
function pp_require_admin(): array {
    $u = pp_require_user();
    if ((int)($u['is_admin'] ?? 0) !== 1) {
        pp_json_error(403, 'Admin only');
    }
    return $u;
}
