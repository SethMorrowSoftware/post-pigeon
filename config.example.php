<?php
// Post Pigeon — configuration template.
// Copy this file to config.php and fill in real values.
// config.php is git-ignored so secrets stay out of version control.

return [

    // ----- MySQL connection -----------------------------------------------
    // On cPanel shared hosting these come from the "MySQL Databases" page.
    // The DSN host is almost always 'localhost' on cPanel.
    'db' => [
        'host'    => 'localhost',
        'port'    => 3306,
        'name'    => 'postpigeon',
        'user'    => 'postpigeon',
        'pass'    => 'change-me',
        'charset' => 'utf8mb4',
    ],

    // ----- Session policy -------------------------------------------------
    // Session lifetime in seconds. Sliding window: every authenticated request
    // refreshes expiry. 30 days is comfortable for a personal-tool workflow.
    'session_ttl_seconds' => 60 * 60 * 24 * 30,

    // Cookie name for the session token.
    'session_cookie' => 'pp_session',

    // Force the cookie to Secure (HTTPS only). Set to false ONLY for local dev
    // over plain http://. On any real deployment leave this true.
    'cookie_secure' => true,

    // ----- Account policy -------------------------------------------------
    // Admin-only invites: regular users cannot self-register. Admins create
    // accounts (with a temporary password) from the admin panel. The first
    // account is created via setup.php and is automatically promoted to admin.
    'allow_self_registration' => false,

    // Minimum password length when a user sets/changes a password.
    'password_min_length' => 10,

    // ----- Brute-force protection ----------------------------------------
    // Failed login attempts allowed per IP per window before login is locked.
    'login_max_attempts' => 8,
    'login_window_seconds' => 15 * 60, // 15 minutes

    // ----- Proxy SSRF guard ----------------------------------------------
    // By default proxy.php refuses to fetch private / loopback / link-local
    // hosts (10.0.0.0/8, 192.168.0.0/16, 127.0.0.0/8, ::1, fe80::/10, etc.)
    // so an authenticated user can't probe the host's internal network.
    // Flip this to true if you really need to test 127.0.0.1 or an internal
    // service from the same box.
    'proxy_allow_private' => false,

    // ----- Proxy response cap --------------------------------------------
    // Maximum response body size proxy.php will buffer, in bytes. A single
    // request can't exceed this — protects shared-hosting PHP processes
    // (typically 128–256 MiB memory_limit) from OOM via a giant response.
    // Floor 64 KiB, ceiling 256 MiB. Default 32 MiB is plenty for any API
    // response you'd realistically debug here.
    'proxy_max_response_bytes' => 32 * 1024 * 1024,
];
