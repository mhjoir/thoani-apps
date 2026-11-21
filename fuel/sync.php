<?php
/* دفتر البنزين: مزامنة البيانات بين الأجهزة.
   كل رمز مزامنة له ملف بيانات مستقل. الدمج: آخر تعديل يفوز لكل سجل، والحذف يُحفظ كعلامة. */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function out($code, $data){ http_response_code($code); echo json_encode($data, JSON_UNESCAPED_UNICODE); exit; }

if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['error' => 'method']);
$origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'])) out(403, ['error' => 'origin']);

$key = isset($_SERVER['HTTP_X_SYNC_KEY']) ? $_SERVER['HTTP_X_SYNC_KEY'] : '';
if (!preg_match('/^[a-f0-9]{64}$/', $key)) out(401, ['error' => 'key']);
$acct = hash('sha256', 'fuel-sync|' . $key);

/* مجلد البيانات خارج مجلد الموقع العام إن أمكن */
$base = dirname(__DIR__, 2) . '/fuel-data';
if (!is_dir($base) && !@mkdir($base, 0700, true)) {
  $base = __DIR__ . '/data';
  if (!is_dir($base)) @mkdir($base, 0700, true);
  if (!file_exists($base . '/.htaccess')) @file_put_contents($base . '/.htaccess', "Require all denied\nDeny from all\n");
}
if (!is_dir($base) || !is_writable($base)) out(500, ['error' => 'storage']);
$dir = $base . '/' . $acct;
$a = isset($_GET['a']) ? $_GET['a'] : 'sync';
$MAX_DOC = 4 * 1024 * 1024; $MAX_BLOB = 3 * 1024 * 1024; $MAX_BLOBS = 300;

function blobIds($dir){
  $ids = [];
  foreach ((array)@glob($dir . '/b_*') as $f) $ids[] = substr(basename($f), 2);
  return $ids;
}

if ($a === 'blobput' || $a === 'blobget') {
  $id = isset($_GET['id']) ? $_GET['id'] : '';
  if (!preg_match('/^[a-z0-9]{8,64}$/', $id)) out(400, ['error' => 'id']);
  if (!is_dir($dir)) out(404, ['error' => 'account']);
  $f = $dir . '/b_' . $id;
  if ($a === 'blobget') {
    if (!is_file($f)) out(404, ['error' => 'missing']);
    out(200, ['data' => file_get_contents($f)]);
  }
  $body = file_get_contents('php://input', false, null, 0, $MAX_BLOB + 1);
  if (strlen($body) > $MAX_BLOB) out(413, ['error' => 'size']);
  if (!preg_match('#^data:image/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$#', $body)) out(400, ['error' => 'format']);
  if (!is_file($f) && count(blobIds($dir)) >= $MAX_BLOBS) out(413, ['error' => 'count']);
  file_put_contents($f, $body, LOCK_EX);
  out(200, ['ok' => true]);
}

if ($a !== 'sync') out(400, ['error' => 'action']);
$raw = file_get_contents('php://input', false, null, 0, $MAX_DOC + 1);
if (strlen($raw) > $MAX_DOC) out(413, ['error' => 'size']);
$in = json_decode($raw, true);
if (!is_array($in)) out(400, ['error' => 'json']);
$inDocs = isset($in['docs']) && is_array($in['docs']) ? $in['docs'] : [];
$inDels = isset($in['dels']) && is_array($in['dels']) ? $in['dels'] : [];
$create = !empty($in['create']);

if (!is_dir($dir)) {
  if (!$create) out(404, ['error' => 'account']);
  if (!@mkdir($dir, 0700, true)) out(500, ['error' => 'storage']);
}
$file = $dir . '/state.json';
$fp = fopen($file, 'c+');
if (!$fp || !flock($fp, LOCK_EX)) out(500, ['error' => 'lock']);
$cur = stream_get_contents($fp);
$st = $cur !== '' ? json_decode($cur, true) : null;
if (!is_array($st)) $st = ['docs' => [], 'dels' => []];
if (!isset($st['docs']) || !is_array($st['docs'])) $st['docs'] = [];
if (!isset($st['dels']) || !is_array($st['dels'])) $st['dels'] = [];
$changed = false;
$okPath = '#^(cars|fills|services|items|settings)/[A-Za-z0-9_-]{1,64}$#';

foreach ($inDels as $p => $t) {
  $t = (float)$t;
  if (!is_string($p) || !preg_match($okPath, $p) || $t <= 0) continue;
  if (isset($st['docs'][$p]) && (float)$st['docs'][$p]['t'] <= $t) { unset($st['docs'][$p]); $changed = true; }
  if (!isset($st['docs'][$p]) && (!isset($st['dels'][$p]) || (float)$st['dels'][$p] < $t)) { $st['dels'][$p] = $t; $changed = true; }
}
foreach ($inDocs as $p => $rec) {
  if (!is_string($p) || !preg_match($okPath, $p) || !is_array($rec) || !isset($rec['d']) || !is_array($rec['d'])) continue;
  $t = isset($rec['t']) ? (float)$rec['t'] : 0;
  if (isset($st['dels'][$p]) && (float)$st['dels'][$p] >= $t) continue;
  if (!isset($st['docs'][$p]) || (float)$st['docs'][$p]['t'] < $t) {
    $st['docs'][$p] = ['t' => $t, 'd' => $rec['d']];
    unset($st['dels'][$p]);
    $changed = true;
  }
}
if ($changed || $cur === '') {
  $json = json_encode($st, JSON_UNESCAPED_UNICODE);
  if ($json === false || strlen($json) > $MAX_DOC) { flock($fp, LOCK_UN); out(413, ['error' => 'size']); }
  ftruncate($fp, 0); rewind($fp); fwrite($fp, $json); fflush($fp);
}
flock($fp, LOCK_UN); fclose($fp);
/* الكائنات الفارغة تبقى كائنات في JSON */
$docs = empty($st['docs']) ? new stdClass() : $st['docs'];
$dels = empty($st['dels']) ? new stdClass() : $st['dels'];
out(200, ['docs' => $docs, 'dels' => $dels, 'blobs' => blobIds($dir), 'now' => round(microtime(true) * 1000)]);
