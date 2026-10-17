(function () {
  document.addEventListener('click', function (event) {
    const button = event.target.closest('[data-toggle-target]');
    if (!button) return;
    const target = document.getElementById(button.dataset.toggleTarget);
    if (!target) return;
    const willOpen = target.hasAttribute('hidden');
    if (willOpen) target.removeAttribute('hidden');
    else target.setAttribute('hidden', 'hidden');
    button.setAttribute('aria-expanded', String(willOpen));
    button.textContent = willOpen ? button.dataset.hideLabel : button.dataset.showLabel;
  });


  const input = document.getElementById('course-search');
  if (!input || !window.LEARNCPP_SEARCH) return;
  const clear = document.getElementById('clear-search');
  const catalog = document.getElementById('chapter-catalog');
  const results = document.getElementById('search-results');
  const count = document.getElementById('result-count');

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, function (char) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }

  function search() {
    const query = input.value.trim().toLocaleLowerCase();
    if (!query) {
      catalog.hidden = false;
      results.hidden = true;
      results.innerHTML = '';
      count.textContent = '';
      return;
    }
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = window.LEARNCPP_SEARCH.map(function (item) {
      const title = item.t.toLocaleLowerCase();
      const body = item.x.toLocaleLowerCase();
      if (!terms.every(function (term) { return title.includes(term) || body.includes(term); })) return null;
      let score = terms.reduce(function (total, term) {
        return total + (title.includes(term) ? 20 : 0) + (body.includes(term) ? 1 : 0);
      }, 0);
      return { item: item, score: score };
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).slice(0, 80);

    catalog.hidden = true;
    results.hidden = false;
    count.textContent = matches.length ? matches.length + ' results' : '';
    if (!matches.length) {
      results.innerHTML = '<div class="empty-result">No results. Try a shorter term such as pointer, vector, or template.</div>';
      return;
    }
    results.innerHTML = matches.map(function (match) {
      const item = match.item;
      const firstTerm = terms.find(function (term) { return item.x.toLocaleLowerCase().includes(term); });
      let start = firstTerm ? item.x.toLocaleLowerCase().indexOf(firstTerm) : 0;
      start = Math.max(0, start - 70);
      const snippet = (start ? '…' : '') + item.x.slice(start, start + 190) + (item.x.length > start + 190 ? '…' : '');
      return '<a class="search-result" href="' + encodeURIComponent(item.u) + '.html">' +
        '<span class="lesson-number">' + escapeHtml(item.n) + '</span>' +
        '<span><span class="result-title">' + escapeHtml(item.t) + '</span>' +
        '<span class="result-snippet">' + escapeHtml(snippet) + '</span></span></a>';
    }).join('');
  }

  input.addEventListener('input', search);
  clear.addEventListener('click', function () { input.value = ''; input.focus(); search(); });
})();
