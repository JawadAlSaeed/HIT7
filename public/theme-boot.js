// Runs before the stylesheet loads, from the <head>. A saved Light or Dark choice is
// stamped on <html> here so the first paint is already the right colour; with no
// choice saved nothing is stamped and the CSS follows the phone's own setting.
// Its own file, not an inline script: the server's Content-Security-Policy is
// script-src 'self', which blocks inline scripts outright. client.js owns the rest
// (the Theme row in Settings, the theme-color meta).
(function () {
    try {
        var t = localStorage.getItem('hit7-theme');
        if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    } catch (e) { /* no storage, no saved choice */ }
})();
