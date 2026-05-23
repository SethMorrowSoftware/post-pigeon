<?php
// api.php — authenticated workspace storage backed by MySQL.
//
//   GET  ?resource=workspace                -> {data: <workspace>}
//   PUT  ?resource=workspace                -> {ok: true}      (body = full workspace)
//
// The existing app.js persists the entire workspace on every change. The
// PUT path performs an atomic replace inside a transaction: collections,
// requests, environments, and history rows are wiped and re-inserted. This
// preserves the simplicity of storage.php's snapshot model while putting
// real, query-able rows in the database.

declare(strict_types=1);

require_once __DIR__ . '/lib/util.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/auth.php';

pp_json_headers();
pp_check_same_origin();

$user = pp_require_user();
$resource = $_GET['resource'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($resource === 'workspace') {
    if ($method === 'GET') {
        pp_json(200, ['data' => pp_workspace_load((int)$user['id'])]);
    }
    if ($method === 'PUT' || $method === 'POST') {
        $body = pp_read_json_body();
        pp_workspace_save((int)$user['id'], $body);
        pp_json(200, ['ok' => true]);
    }
    pp_json_error(405, 'Method not allowed');
}

pp_json_error(400, 'Unknown resource');

/* ============================================================ */
/* Workspace I/O                                                */
/* ============================================================ */

/**
 * Load the user's full workspace into the same shape the front-end persists.
 *
 * @return array<string,mixed>
 */
function pp_workspace_load(int $userId): array {
    // Environments
    $envRows = pp_db_all(
        'SELECT id, name, variables, sort_order
           FROM environments WHERE user_id = ? ORDER BY sort_order, created_at',
        [$userId]
    );
    $envs = [];
    foreach ($envRows as $r) {
        $vars = pp_json_decode_any($r['variables']);
        $envs[] = [
            'id'   => $r['id'],
            'name' => $r['name'],
            'vars' => is_array($vars) ? $vars : [],
        ];
    }

    // Collections + their saved requests
    $colRows = pp_db_all(
        'SELECT id, name, is_open, sort_order
           FROM collections WHERE user_id = ? ORDER BY sort_order, created_at',
        [$userId]
    );
    $reqRows = pp_db_all(
        'SELECT id, collection_id, name, method, url, payload, sort_order
           FROM saved_requests WHERE user_id = ? ORDER BY sort_order, created_at',
        [$userId]
    );
    $byCollection = [];
    foreach ($reqRows as $r) {
        $payload = pp_json_decode_any($r['payload']);
        if (!is_array($payload)) $payload = [];
        // Restore the canonical request shape used by app.js.
        $payload['id'] = $r['id'];
        $payload['name'] = $r['name'];
        $payload['method'] = $r['method'];
        $payload['url'] = $r['url'];
        $byCollection[$r['collection_id']][] = $payload;
    }
    $collections = [];
    foreach ($colRows as $c) {
        $collections[] = [
            'id'       => $c['id'],
            'name'     => $c['name'],
            'open'     => (int)$c['is_open'] === 1,
            'requests' => $byCollection[$c['id']] ?? [],
        ];
    }

    // History
    $histRows = pp_db_all(
        'SELECT id, ts, method, url, status, time_ms, snapshot
           FROM history WHERE user_id = ? ORDER BY ts DESC LIMIT 200',
        [$userId]
    );
    $history = [];
    foreach ($histRows as $h) {
        $snap = $h['snapshot'] !== null ? pp_json_decode_any($h['snapshot']) : null;
        $history[] = [
            'id'     => $h['id'],
            'ts'     => (int)$h['ts'],
            'method' => $h['method'],
            'url'    => $h['url'],
            'status' => (int)$h['status'],
            'timeMs' => (int)$h['time_ms'],
            'snapshot' => is_array($snap) ? $snap : null,
        ];
    }

    // Active env
    $settings = pp_db_one('SELECT active_env_id FROM user_settings WHERE user_id = ?', [$userId]);
    $activeEnvId = $settings['active_env_id'] ?? null;
    if ($activeEnvId !== null && !pp_array_has_id($envs, $activeEnvId)) {
        $activeEnvId = $envs[0]['id'] ?? null;
    } elseif ($activeEnvId === null && !empty($envs)) {
        $activeEnvId = $envs[0]['id'];
    }

    return [
        'collections' => $collections,
        'history'     => $history,
        'envs'        => $envs,
        'activeEnvId' => $activeEnvId,
    ];
}

/**
 * Save the workspace. Atomic: either everything is replaced or nothing
 * changes. History is capped to the most recent 200 entries.
 */
function pp_workspace_save(int $userId, array $snap): void {
    $envs        = is_array($snap['envs']        ?? null) ? $snap['envs']        : [];
    $collections = is_array($snap['collections'] ?? null) ? $snap['collections'] : [];
    $history     = is_array($snap['history']     ?? null) ? $snap['history']     : [];
    $activeEnvId = is_string($snap['activeEnvId']?? null) ? $snap['activeEnvId'] : null;

    $pdo = pp_db();
    $pdo->beginTransaction();
    try {
        pp_db_exec('DELETE FROM environments  WHERE user_id = ?', [$userId]);
        pp_db_exec('DELETE FROM saved_requests WHERE user_id = ?', [$userId]);
        pp_db_exec('DELETE FROM collections   WHERE user_id = ?', [$userId]);
        pp_db_exec('DELETE FROM history       WHERE user_id = ?', [$userId]);

        $envIns = $pdo->prepare(
            'INSERT INTO environments (id, user_id, name, variables, sort_order)
             VALUES (?, ?, ?, ?, ?)'
        );
        $envIds = [];
        foreach ($envs as $i => $e) {
            if (!is_array($e)) continue;
            $id   = pp_safe_id((string)($e['id'] ?? ''));
            $name = pp_clip((string)($e['name'] ?? 'Untitled'), 128);
            $vars = is_array($e['vars'] ?? null) ? $e['vars'] : [];
            $envIns->execute([$id, $userId, $name, json_encode($vars), $i]);
            $envIds[$id] = true;
        }

        $colIns = $pdo->prepare(
            'INSERT INTO collections (id, user_id, name, is_open, sort_order)
             VALUES (?, ?, ?, ?, ?)'
        );
        $reqIns = $pdo->prepare(
            'INSERT INTO saved_requests (id, user_id, collection_id, name, method, url, payload, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        foreach ($collections as $ci => $c) {
            if (!is_array($c)) continue;
            $cid  = pp_safe_id((string)($c['id'] ?? ''));
            $name = pp_clip((string)($c['name'] ?? 'Untitled'), 128);
            $open = !empty($c['open']) ? 1 : 0;
            $colIns->execute([$cid, $userId, $name, $open, $ci]);
            $reqs = is_array($c['requests'] ?? null) ? $c['requests'] : [];
            foreach ($reqs as $ri => $r) {
                if (!is_array($r)) continue;
                $rid    = pp_safe_id((string)($r['id'] ?? ''));
                $rname  = pp_clip((string)($r['name']   ?? 'Untitled'), 255);
                $method = pp_clip(strtoupper((string)($r['method'] ?? 'GET')), 10);
                $url    = (string)($r['url'] ?? '');
                $reqIns->execute([$rid, $userId, $cid, $rname, $method, $url, json_encode($r), $ri]);
            }
        }

        $histIns = $pdo->prepare(
            'INSERT INTO history (id, user_id, ts, method, url, status, time_ms, snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        // Keep only the most recent 200 entries; sort by ts desc and slice.
        usort($history, fn($a, $b) => (int)($b['ts'] ?? 0) <=> (int)($a['ts'] ?? 0));
        $history = array_slice($history, 0, 200);
        foreach ($history as $h) {
            if (!is_array($h)) continue;
            $hid    = pp_safe_id((string)($h['id'] ?? ''));
            $ts     = (int)($h['ts'] ?? 0);
            $method = pp_clip(strtoupper((string)($h['method'] ?? 'GET')), 10);
            $url    = (string)($h['url'] ?? '');
            $status = (int)($h['status'] ?? 0);
            $time   = (int)($h['timeMs'] ?? 0);
            $snapJ  = isset($h['snapshot']) ? json_encode($h['snapshot']) : null;
            $histIns->execute([$hid, $userId, $ts, $method, $url, $status, $time, $snapJ]);
        }

        // Settings (active env)
        if ($activeEnvId !== null && !isset($envIds[$activeEnvId])) {
            $activeEnvId = null;
        }
        pp_db_exec(
            'INSERT INTO user_settings (user_id, active_env_id) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE active_env_id = VALUES(active_env_id)',
            [$userId, $activeEnvId]
        );

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        error_log('post-pigeon: workspace save failed: ' . $e->getMessage());
        pp_json_error(500, 'Failed to save workspace.');
    }
}

/* ---------------- helpers ---------------- */

/**
 * Some MySQL drivers return JSON columns already decoded, others return them
 * as strings. Handle both.
 */
function pp_json_decode_any($v) {
    if (is_array($v) || is_object($v)) return $v;
    if (!is_string($v) || $v === '') return null;
    $d = json_decode($v, true);
    return is_array($d) ? $d : null;
}

/**
 * Sanitise an id supplied by the client. The front-end uses base36 ids
 * (Math.random().toString(36)); we accept them verbatim so cross-references
 * like activeEnvId still resolve after a round-trip. Falls back to a random
 * id if the client sent something unusable.
 */
function pp_safe_id(string $raw): string {
    $clean = preg_replace('/[^A-Za-z0-9_\-]/', '', $raw);
    if ($clean === null || $clean === '' || strlen($clean) < 4) {
        return bin2hex(random_bytes(6));
    }
    if (strlen($clean) > 16) $clean = substr($clean, 0, 16);
    return $clean;
}

function pp_clip(string $s, int $max): string {
    // Use the UTF-8 safe helper so multi-byte names don't get split mid-char,
    // which would otherwise produce mojibake or trigger MySQL utf8mb4 errors.
    return pp_clip_utf8($s, $max);
}

function pp_array_has_id(array $arr, string $id): bool {
    foreach ($arr as $row) if (($row['id'] ?? null) === $id) return true;
    return false;
}
