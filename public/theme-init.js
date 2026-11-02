/* Load saved display preferences before paint. */
(function () {
  var valid = {
    'Catppuccin Mocha': 'dark',
    'Nord': 'dark',
    'Catppuccin Latte': 'light',
    'Claude': 'light'
  };
  var t = 'Catppuccin Mocha', d = 'comfortable';
  try {
    var s = localStorage.getItem('pochita-theme');
    if (s && valid[s]) t = s;
    if (localStorage.getItem('pochita-density') === 'compact') d = 'compact';
  } catch (_) {}
  document.documentElement.dataset.theme = valid[t] || 'dark';
  document.documentElement.dataset.palette = t;
  document.documentElement.dataset.density = d;
})();