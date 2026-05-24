<?php
// proxy.php — Post Pigeon's server-side cURL proxy so the browser can hit any API
// without CORS interference. Returns a JSON envelope with the response
// body, status, headers, real timing phases, and effective request metadata.
//
// Authentication: the caller must hold a valid session cookie. This is what
// stops a public deployment from being abused as an open SSRF gateway.

declare(strict_types=1);

require_once __DIR__ . '/lib/util.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/auth.php';

pp_json_headers();
pp_check_same_origin();
pp_require_user();

if (!function_exists('curl_init')) {
    pp_json_error(500, 'PHP cURL extension is not enabled on this host.');
}

// We only consume JSON. Refusing other content types blocks form-encoded
// CSRF attempts even when a deployment's Origin header is stripped by a proxy.
$ct = $_SERVER['CONTENT_TYPE'] ?? '';
if ($ct !== '' && stripos($ct, 'application/json') === false) {
    pp_json_error(415, 'Expected Content-Type: application/json');
}

$req = pp_read_json_body();
if (empty($req['url']) || !is_string($req['url'])) {
    pp_json_error(400, 'Missing url');
}

$url = (string)$req['url'];
// Only allow http(s) — blocks file://, gopher://, dict://, etc.
$scheme = strtolower((string)(parse_url($url, PHP_URL_SCHEME) ?: ''));
if ($scheme !== 'http' && $scheme !== 'https') {
    pp_json_error(400, 'Only http and https URLs are allowed');
}

// SSRF guard: by default refuse private / loopback / link-local targets so an
// authenticated user can't probe the host's internal network through us.
// Operators who actually need this (e.g. testing 127.0.0.1 on a dev box) can
// set 'proxy_allow_private' => true in config.php.
if (!pp_config_get('proxy_allow_private', false)) {
    $reason = pp_ssrf_block_reason($url);
    if ($reason !== null) {
        pp_json_error(400, 'Refusing to proxy: ' . $reason);
    }
}

$method  = strtoupper((string)preg_replace('/[^A-Z]/i', '', (string)($req['method'] ?? 'GET'))) ?: 'GET';
$headers = is_array($req['headers'] ?? null) ? $req['headers'] : [];
$body    = $req['body'] ?? null;
$timeout = pp_clamp_int($req['timeout'] ?? 30, 1, 600, 30);
$followRedirects = !empty($req['followRedirects']);
$verifySSL = !array_key_exists('verifySSL', $req) ? true : (bool)$req['verifySSL'];

// Cap the response body so a single proxied request can't exhaust PHP's
// memory_limit. Configurable, but always bounded — shared-hosting PHP
// processes are typically capped at 128–256 MiB total.
$maxResponseBytes = pp_clamp_int(
    pp_config_get('proxy_max_response_bytes', 32 * 1024 * 1024),
    64 * 1024,         // 64 KiB minimum so the guard isn't useless
    256 * 1024 * 1024, // 256 MiB hard ceiling
    32 * 1024 * 1024   // 32 MiB default
);

$respHeaders = '';
$respBody    = '';
$tooLarge    = false;

$ch = curl_init();
$curlOpts = [
    CURLOPT_URL            => $url,
    CURLOPT_CUSTOMREQUEST  => $method,
    // Capture headers + body via callbacks so we can hard-cap the body size.
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER         => false,
    CURLOPT_HEADERFUNCTION => static function ($_ch, string $hdr) use (&$respHeaders): int {
        $respHeaders .= $hdr;
        return strlen($hdr);
    },
    CURLOPT_WRITEFUNCTION  => static function ($_ch, string $chunk) use (&$respBody, &$tooLarge, $maxResponseBytes): int {
        if ($tooLarge) return 0;
        if (strlen($respBody) + strlen($chunk) > $maxResponseBytes) {
            $tooLarge = true;
            return 0; // returning < len(chunk) signals libcurl to abort
        }
        $respBody .= $chunk;
        return strlen($chunk);
    },
    // Fast path: if the server sends a Content-Length above the cap, abort
    // before downloading a byte.
    CURLOPT_MAXFILESIZE    => $maxResponseBytes,
    CURLOPT_TIMEOUT        => $timeout,
    CURLOPT_CONNECTTIMEOUT => min($timeout, 15),
    CURLOPT_FOLLOWLOCATION => $followRedirects,
    CURLOPT_MAXREDIRS      => 10,
    CURLOPT_SSL_VERIFYPEER => $verifySSL,
    CURLOPT_SSL_VERIFYHOST => $verifySSL ? 2 : 0,
    CURLOPT_ENCODING       => '',
];

// CURLOPT_PROTOCOLS_STR is the modern (cURL 7.85+) equivalent; older libcurl
// versions still need the bitmask constants. Use whichever is available so we
// don't trip deprecation warnings on newer hosts.
if (defined('CURLOPT_PROTOCOLS_STR')) {
    $curlOpts[CURLOPT_PROTOCOLS_STR]       = 'http,https';
    $curlOpts[CURLOPT_REDIR_PROTOCOLS_STR] = 'http,https';
} else {
    $curlOpts[CURLOPT_PROTOCOLS]       = CURLPROTO_HTTP | CURLPROTO_HTTPS;
    $curlOpts[CURLOPT_REDIR_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
}
curl_setopt_array($ch, $curlOpts);

$hdrLines = [];
$hasUA = false;
foreach ($headers as $h) {
    if (!is_array($h) || empty($h['name'])) continue;
    $name = (string)$h['name'];
    // Strip CR/LF to defeat header injection.
    if (preg_match('/[\r\n]/', $name)) continue;
    $value = isset($h['value']) ? preg_replace('/[\r\n]+/', ' ', (string)$h['value']) : '';
    if (strcasecmp($name, 'user-agent') === 0) $hasUA = true;
    $hdrLines[] = $name . ': ' . $value;
}
if (!$hasUA) $hdrLines[] = 'User-Agent: PostPigeon/1.0';
curl_setopt($ch, CURLOPT_HTTPHEADER, $hdrLines);

if ($body !== null && $body !== '' && !in_array($method, ['GET','HEAD'], true)) {
    if (!is_string($body)) $body = json_encode($body);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

$t0 = microtime(true);
$ok = curl_exec($ch);
$t1 = microtime(true);

if ($ok === false) {
    $err   = curl_error($ch) ?: 'cURL request failed';
    $errno = curl_errno($ch);
    curl_close($ch);
    if ($tooLarge) {
        pp_json(502, [
            'error'  => 'Response exceeded the configured maximum of '
                        . number_format($maxResponseBytes) . ' bytes.',
            'errno'  => $errno,
            'timeMs' => (int)(($t1 - $t0) * 1000),
        ]);
    }
    pp_json(502, [
        'error'  => $err,
        'errno'  => $errno,
        'timeMs' => (int)(($t1 - $t0) * 1000),
    ]);
}

$info       = curl_getinfo($ch);
$rawHeaders = $respHeaders;

// Parse the LAST response's headers — cURL concatenates 1xx and redirect
// preludes when followLocation is on, so we want the final block.
$blocks = preg_split("/\r?\n\r?\n/", trim($rawHeaders));
$lastBlock = is_array($blocks) ? (string)end($blocks) : '';
$parsedHeaders = [];
foreach (preg_split("/\r?\n/", $lastBlock) ?: [] as $i => $line) {
    if ($i === 0) continue; // status line
    if (strpos($line, ':') === false) continue;
    [$k, $v] = explode(':', $line, 2);
    $parsedHeaders[] = ['name' => trim($k), 'value' => trim($v)];
}

// Real timing breakdown from libcurl. All values are seconds-since-start of
// the transfer, so we diff them to get phase durations. See:
//   namelookup_time → DNS
//   connect_time    → connect (TCP)
//   appconnect_time → TLS handshake (0 on plain http)
//   pretransfer_time→ ready-to-send pivot
//   starttransfer_time → time to first response byte (server "wait")
//   total_time      → end of transfer
$ms = static fn(float $s): int => (int)round($s * 1000);
$nl  = (float)($info['namelookup_time']    ?? 0);
$cn  = (float)($info['connect_time']       ?? 0);
$ac  = (float)($info['appconnect_time']    ?? 0);
$pt  = (float)($info['pretransfer_time']   ?? 0);
$st  = (float)($info['starttransfer_time'] ?? 0);
$tot = (float)($info['total_time']         ?? ($t1 - $t0));

$phases = [
    'dns'      => $ms($nl),
    'tcp'      => $ms(max(0.0, $cn - $nl)),
    'tls'      => $ms(max(0.0, $ac > 0 ? $ac - $cn : 0.0)),
    'wait'     => $ms(max(0.0, $st - $pt)),
    'download' => $ms(max(0.0, $tot - $st)),
    'total'    => $ms($tot),
];

curl_close($ch);

$envelope = [
    'status'    => (int)($info['http_code']      ?? 0),
    'timeMs'    => $phases['total'] ?: (int)(($t1 - $t0) * 1000),
    'sizeBytes' => strlen($respBody),
    'headers'   => $parsedHeaders,
    'body'      => $respBody,
    'finalUrl'  => (string)($info['url']            ?? $url),
    'redirects' => (int)($info['redirect_count'] ?? 0),
    'phases'    => $phases,
];

// JSON_INVALID_UTF8_SUBSTITUTE keeps non-UTF-8 / binary bodies from crashing the encode.
$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
$out = json_encode($envelope, $flags);

if ($out === false) {
    // Last-ditch fallback: base64-encode the body so the envelope is always
    // valid JSON. The client decodes when bodyEncoding === 'base64'.
    $envelope['body']         = base64_encode($respBody);
    $envelope['bodyEncoding'] = 'base64';
    $out = json_encode($envelope, JSON_UNESCAPED_SLASHES);
}

if ($out === false) {
    pp_json_error(502, 'Could not encode response');
}
echo $out;
