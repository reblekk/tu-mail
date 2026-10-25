// Interface language: English (the source strings in the code) or German. Instead of wrapping every
// string in a lookup, German is applied by translating text the page puts into the DOM: exact
// English strings from i18n-de.js, plus a few patterns for sentences with numbers or names in them.
// Switching language reloads the page, so nothing has to be translated back.
(function (root) {
  var KEY = 'tu-mail-lang';
  var dict = {};
  var patterns = [];
  var lang = 'en';

  function detect() {
    try { var saved = localStorage.getItem(KEY); if (saved === 'en' || saved === 'de') return saved; } catch (e) { /* use browser language */ }
    var nav = (typeof navigator !== 'undefined' && (navigator.language || '')) || '';
    return /^de\b/i.test(nav) ? 'de' : 'en';
  }

  function translate(text) {
    if (lang !== 'de' || !text) return text;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    var core = m[2].replace(/\s+/g, ' ');
    if (!core) return text;
    var out = Object.prototype.hasOwnProperty.call(dict, core) ? dict[core] : undefined;
    if (out === undefined) {
      for (var i = 0; i < patterns.length; i++) {
        var match = patterns[i][0].exec(core);
        if (match) { out = patterns[i][1].apply(null, match.slice(1)); break; }
      }
    }
    return out === undefined ? text : m[1] + out + m[3];
  }

  // User content (subjects, senders, previews, contact names) must never be translated.
  var SKIP = 'script,style,textarea,iframe,[contenteditable="true"],[data-i18n-skip],.msg-subject,.mail-item .from,.mail-item .subject,.mail-item .preview,.card-name,.card-addr,.contact-row span,.cmp-chip';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  function skipped(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    return !el || !!(el.closest && el.closest(SKIP));
  }
  function textNode(node) {
    var next = translate(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  function attributes(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var value = el.getAttribute(ATTRS[i]);
      if (value) { var next = translate(value); if (next !== value) el.setAttribute(ATTRS[i], next); }
    }
  }
  function tree(rootNode) {
    if (lang !== 'de' || !rootNode) return;
    if (rootNode.nodeType === 3) { if (!skipped(rootNode)) textNode(rootNode); return; }
    if (rootNode.nodeType !== 1 || skipped(rootNode)) return;
    if (rootNode.querySelectorAll) {
      var walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) if (!skipped(n)) textNode(n);
      attributes(rootNode);
      var els = rootNode.querySelectorAll('[placeholder],[title],[aria-label],[alt]');
      for (var i = 0; i < els.length; i++) if (!skipped(els[i])) attributes(els[i]);
    }
  }

  function start() {
    document.documentElement.lang = lang;
    if (lang !== 'de') return;
    document.title = translate(document.title);
    tree(document.body);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList') for (var j = 0; j < r.addedNodes.length; j++) tree(r.addedNodes[j]);
        else if (r.type === 'characterData') { if (!skipped(r.target)) textNode(r.target); }
        else if (r.type === 'attributes' && !skipped(r.target)) attributes(r.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  lang = detect();
  root.TuI18n = {
    get lang() { return lang; },
    t: translate,
    define: function (entries, extra) {
      Object.keys(entries).forEach(function (k) { dict[k] = entries[k]; });
      (extra || []).forEach(function (p) { patterns.push(p); });
    },
    set: function (next) {
      try { localStorage.setItem(KEY, next === 'de' ? 'de' : 'en'); } catch (e) { /* keeps the detected language */ }
      location.reload();
    },
    _reset: function (next) { lang = next; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TuI18n;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
