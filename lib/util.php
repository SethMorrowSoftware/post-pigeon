<?php
// lib/util.php — shared helpers for JSON I/O, configuration loading,
// CSRF/origin checks, and small primitives. Required by every public
// PHP entry point; never served directly thanks to lib/.htaccess.

declare(strict_types=1);

if (!defined('PP_ROOT')) {
    define('PP_ROOT', dirname(__DIR__));
}

/**
 * Load and cache the deployment config. Falls back to config.example.php so
 * setup.php can still render a helpful error before config.php exists.
 *
 * @return array<string,mixed>
 */
function pp_config(): array {
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $real    = PP_ROOT . '/config.php';
    $example = PP_ROOT . '/config.example.php';
    if (is_file($real)) {
        $cfg = require $real;
    } elseif (is_file($example)) {
        $cfg = require $example;
    } else {
        $cfg = [];
    }
    if (!is_array($cfg)) $cfg = [];
    return $cfg;
}

function pp_config_get(string $path, $default = null) {
    $cur = pp_config();
    foreach (explode('.', $path) as $part) {
        if (is_array($cur) && array_key_exists($part, $cur)) {
            $cur = $cur[$part];
        } else {
            return $default;
        }
    }
    return $cur;
}

function pp_config_present(): bool {
    return is_file(PP_ROOT . '/config.php');
}

function pp_json_headers(): void {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
}

/**
 * Send a JSON response and exit. Use for both happy paths and errors.
 */
function pp_json(int $status, array $payload): void {
    if (!headers_sent()) {
        http_response_code($status);
        pp_json_headers();
    }
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function pp_json_error(int $status, string $message, array $extra = []): void {
    pp_json($status, array_merge(['error' => $message], $extra));
}

/**
 * Read the raw POST body and decode as JSON. Caps payload size and rejects
 * malformed input. Returns [] for an empty body to keep callers simple.
 *
 * @return array<string,mixed>
 */
function pp_read_json_body(int $maxBytes = 16 * 1024 * 1024): array {
    $raw = file_get_contents('php://input');
    if ($raw === false) pp_json_error(400, 'Could not read request body');
    if (strlen($raw) > $maxBytes) pp_json_error(413, 'Request body too large');
    if ($raw === '') return [];
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        pp_json_error(400, 'Body is not a JSON object');
    }
    return $decoded;
}

/**
 * Constant-time comparison wrapper.
 */
function pp_hash_equals(string $a, string $b): bool {
    return hash_equals($a, $b);
}

/**
 * Pull the client IP. Trusts X-Forwarded-For only when the request comes from
 * loopback (i.e. behind a reverse proxy on the same host). cPanel direct
 * deployments fall through to REMOTE_ADDR, which is what we want.
 */
function pp_client_ip(): string {
    $remote = $_SERVER['REMOTE_ADDR'] ?? '';
    $loopback = ($remote === '127.0.0.1' || $remote === '::1');
    if ($loopback && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $first = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
        if ($first !== '') return $first;
    }
    return $remote ?: '';
}

function pp_user_agent(int $max = 255): string {
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    if (strlen($ua) > $max) $ua = substr($ua, 0, $max);
    return $ua;
}

/**
 * Same-origin check for state-changing requests. Browsers send Origin on every
 * cross-site fetch; if it's present and disagrees with our host we refuse.
 * Combined with SameSite=Lax cookies this is a complete CSRF defence without
 * needing a CSRF token.
 */
function pp_check_same_origin(): void {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) return;
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        // Some same-origin POSTs (e.g. form submits) omit Origin; fall back to Referer.
        $origin = $_SERVER['HTTP_REFERER'] ?? '';
    }
    if ($origin === '') return; // no header to verify; rely on SameSite cookie
    $host = $_SERVER['HTTP_HOST'] ?? '';
    // Strip default ports so https://example.com:443 matches example.com.
    $hostNoPort = preg_replace('/:(80|443)$/', '', $host);
    $originHost = parse_url($origin, PHP_URL_HOST) ?? '';
    $originPort = parse_url($origin, PHP_URL_PORT);
    if ($originPort && !in_array((int)$originPort, [80, 443], true)) {
        $originHost .= ':' . $originPort;
    }
    if ($originHost !== $host && $originHost !== $hostNoPort) {
        pp_json_error(403, 'Cross-origin request blocked');
    }
}

/**
 * Decide whether a hostname/IP literal points at an internal or otherwise
 * disallowed target. Used by proxy.php to defend against SSRF abuse beyond
 * the auth gate. We resolve hostnames first so an attacker can't slip
 * something like `internal.example.com` that returns 10.0.0.1.
 *
 * Returns null if OK, or a string reason describing why it was blocked.
 */
function pp_ssrf_block_reason(string $url): ?string {
    $host = parse_url($url, PHP_URL_HOST);
    if (!$host) return 'invalid host';
    // Strip surrounding brackets from raw IPv6 literals.
    $host = trim($host, '[]');

    $ips = [];
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips[] = $host;
    } else {
        // Resolve A + AAAA. dns_get_record is disabled on some shared hosts,
        // so fall back to gethostbyname for IPv4 — without that fallback the
        // guard would silently no-op when DNS functions are restricted.
        if (function_exists('dns_get_record')) {
            $a = @dns_get_record($host, DNS_A);
            if (is_array($a)) foreach ($a as $r) if (!empty($r['ip']))   $ips[] = $r['ip'];
            $aaaa = @dns_get_record($host, DNS_AAAA);
            if (is_array($aaaa)) foreach ($aaaa as $r) if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
        }
        if (!$ips) {
            $resolved = @gethostbyname($host);
            if ($resolved && $resolved !== $host && filter_var($resolved, FILTER_VALIDATE_IP)) {
                $ips[] = $resolved;
            }
        }
    }
    foreach ($ips as $ip) {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return 'target resolves to a private / reserved address (' . $ip . ')';
        }
    }
    return null;
}

/**
 * UTF-8 safe truncation. Falls back to strlen-based clipping if the mbstring
 * extension is unavailable.
 */
function pp_clip_utf8(string $s, int $maxChars): string {
    if (function_exists('mb_substr') && function_exists('mb_strlen')) {
        return mb_strlen($s, 'UTF-8') <= $maxChars
            ? $s
            : mb_substr($s, 0, $maxChars, 'UTF-8');
    }
    return strlen($s) <= $maxChars ? $s : substr($s, 0, $maxChars);
}

function pp_random_id(int $bytes = 8): string {
    return bin2hex(random_bytes($bytes));
}

function pp_random_token(int $bytes = 32): string {
    return bin2hex(random_bytes($bytes));
}

function pp_now_utc(): string {
    return gmdate('Y-m-d H:i:s');
}

function pp_future_utc(int $secondsFromNow): string {
    return gmdate('Y-m-d H:i:s', time() + $secondsFromNow);
}

function pp_is_email(string $s): bool {
    return filter_var($s, FILTER_VALIDATE_EMAIL) !== false && strlen($s) <= 190;
}

function pp_is_username(string $s): bool {
    return (bool)preg_match('/^[A-Za-z0-9_.\-]{3,64}$/', $s);
}

function pp_clamp_int($v, int $min, int $max, int $default): int {
    if (!is_numeric($v)) return $default;
    $n = (int)$v;
    if ($n < $min) return $min;
    if ($n > $max) return $max;
    return $n;
}
