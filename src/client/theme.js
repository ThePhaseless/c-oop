// A stored theme goes on <html> before the first paint; main.js would be a flash of the other theme too late.
// A file of its own because the CSP allows no inline script. The key is THEME_KEY in ui.ts.
try {
  var t = localStorage.getItem('c-oop.theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) {}
