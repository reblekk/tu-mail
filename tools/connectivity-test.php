<?php
// One-time check: can THIS web host open connections to the university mail servers?
// Upload it to a spare domain or subdomain (not into another application's folder), open it once with
// your secret key, read the result, then DELETE THE FILE. It reads no mail and stores nothing.
//
//   https://your-test-domain.example/connectivity-test.php?key=YOUR_SECRET
//
// Change the key below to a long random string first. The page refuses to run until you do.
// Written for old PHP versions too (5.4 and later), and every message is shown on screen.
$KEY = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';

@ini_set('display_errors', '1');
error_reporting(E_ALL);
header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');

echo "TUDa Mail connectivity check\n";
echo "PHP " . PHP_VERSION . "\n\n";

if ($KEY === 'CHANGE_ME_TO_A_LONG_RANDOM_STRING' || strlen($KEY) < 16) {
  echo "Not run: open this file and set \$KEY near the top to a long random string (at least 16 characters),\n";
  echo "then open this page again with ?key=THAT_STRING at the end of the address.\n";
  exit;
}
if (!isset($_GET['key']) || $_GET['key'] !== $KEY) {
  echo "Not run: the key in the address does not match \$KEY in the file.\n";
  exit;
}
if (!function_exists('stream_socket_client')) {
  echo "This host has switched off stream_socket_client, so outgoing connections cannot be tested from PHP.\n";
  exit;
}

// host, port, what it is
$targets = array(
  array('www.google.com',            443, 'control: ordinary website (must work, or outgoing connections are blocked entirely)'),
  array('imap.stud.tu-darmstadt.de', 993, 'TU student IMAP  <- the one that matters'),
  array('smtp.tu-darmstadt.de',      465, 'TU SMTP (sending)  <- also needed'),
  array('mail.tu-darmstadt.de',      993, 'TU Exchange IMAP (other TU accounts)'),
  array('mailbox.tu-darmstadt.de',   993, 'TU Linux mailbox IMAP (other TU accounts)'),
);

echo "Time limit for each test: 8 seconds\n\n";
foreach ($targets as $t) {
  $host = $t[0]; $port = $t[1]; $what = $t[2];
  $start = microtime(true);
  $ctx = stream_context_create(array('ssl' => array('verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true, 'peer_name' => $host)));
  $errno = 0; $errstr = '';
  $socket = @stream_socket_client("ssl://$host:$port", $errno, $errstr, 8, STREAM_CLIENT_CONNECT, $ctx);
  $ms = round((microtime(true) - $start) * 1000);
  if ($socket) {
    stream_set_timeout($socket, 3);
    $greeting = trim((string)fgets($socket, 120));
    fclose($socket);
    echo "OK      $host:$port ($ms ms)  $what\n        server says: " . substr($greeting, 0, 80) . "\n";
  } else {
    $why = ($errno === 0 && $ms >= 7500) ? 'timed out (blocked by a firewall?)' : trim("$errno $errstr");
    echo "FAILED  $host:$port ($ms ms)  $what\n        $why\n";
  }
}
echo "\nHow to read this:\n";
echo " - Control OK + TU IMAP/SMTP OK  -> this host can reach the university servers.\n";
echo " - Control OK + TU FAILED/timed out -> the host or the university blocks them; ask the host to open the port,\n";
echo "   and ask HRZ whether student IMAP is open to outside addresses.\n";
echo " - Control FAILED -> this host blocks outgoing connections altogether.\n";
echo "\nNow delete this file from the server.\n";
