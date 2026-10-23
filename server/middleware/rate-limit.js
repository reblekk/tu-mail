// Login throttling. The IP limit slows anyone hammering the endpoint; the account limit slows password
// guessing against one mailbox from many addresses. Both are in memory, matching the single-instance
// session store, and are bounded so an attacker cannot grow them without limit.
const MAX_KEYS = 50000;

function createLoginLimiter({ ipPerMinute, accountFailures, accountWindowMs }, now = Date.now) {
  const ips = new Map();       // ip -> timestamps of attempts in the last minute
  const accounts = new Map();  // account -> timestamps of failures inside the window

  const prune = (list, windowMs) => { const cutoff = now() - windowMs; while (list.length && list[0] <= cutoff) list.shift(); return list; };
  const bounded = (map, key) => { if (!map.has(key) && map.size >= MAX_KEYS) map.delete(map.keys().next().value); };

  function retryAfter(list, limit, windowMs) {
    return prune(list, windowMs).length >= limit ? Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) : 0;
  }

  return {
    // Counts the request against the IP. Returns seconds to wait, or 0 if allowed.
    checkIp(ip) {
      const list = ips.get(ip) || [];
      const wait = retryAfter(list, ipPerMinute, 60000);
      if (wait) return wait;
      list.push(now()); bounded(ips, ip); ips.set(ip, list);
      return 0;
    },
    checkAccount(account) {
      return retryAfter(accounts.get(account) || [], accountFailures, accountWindowMs);
    },
    recordFailure(account) {
      const list = accounts.get(account) || [];
      list.push(now()); bounded(accounts, account); accounts.set(account, list);
    },
    recordSuccess(account) { accounts.delete(account); },
    sweep() {
      for (const [key, list] of ips) if (!prune(list, 60000).length) ips.delete(key);
      for (const [key, list] of accounts) if (!prune(list, accountWindowMs).length) accounts.delete(key);
    },
    size() { return { ips: ips.size, accounts: accounts.size }; },
  };
}

module.exports = { createLoginLimiter };
