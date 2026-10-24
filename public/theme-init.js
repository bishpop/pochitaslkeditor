/* Pochita SLK Editor theme preference initializer. No backend required. */
(function(){
  var theme='light';
  try {
    var saved=localStorage.getItem('pochita-theme');
    if(saved==='dark'||saved==='light') theme=saved;
  } catch (_) { /* Storage may be unavailable in private browsing. */ }
  document.documentElement.dataset.theme=theme;
})();
