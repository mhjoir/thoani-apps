<?php
/* Copies the app folders from this checkout into the live site folders next to it.
   Run from the command line only (cron); web access to this directory is denied by .htaccess. */
if (php_sapi_name() !== 'cli') { http_response_code(403); exit; }
$src = __DIR__;
$dst = dirname(__DIR__);
$apps = ['fuel', 'masroof', 'arkhas', 'budget'];
function copy_tree($from, $to, &$out) {
    if (!is_dir($to) && !mkdir($to, 0755, true)) { $out[] = "FAIL mkdir $to"; return; }
    foreach (scandir($from) as $name) {
        if ($name === '.' || $name === '..' || $name === '.git') continue;
        $a = "$from/$name"; $b = "$to/$name";
        if (is_dir($a)) { copy_tree($a, $b, $out); continue; }
        if (is_file($b) && hash_file('sha256', $a) === hash_file('sha256', $b)) continue;
        $out[] = (copy($a, $b) ? 'OK ' : 'FAIL ') . substr(hash_file('sha256', $a), 0, 16) . ' ' . substr($b, strlen(dirname(__DIR__)) + 1);
    }
}
$out = [];
foreach ($apps as $app) {
    if (is_dir("$src/$app")) copy_tree("$src/$app", "$dst/$app", $out);
}
echo $out ? implode("\n", $out) : 'nothing to copy', "\n";
