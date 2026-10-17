(async function () {
  'use strict';
  const article = document.querySelector('.article-content');
  const toolbar = document.querySelector('[data-highlight-toolbar]');
  const status = document.getElementById('folder-status');
  const resume = document.getElementById('resume-reading');
  const slug = article ? decodeURIComponent(location.pathname.split('/').pop()).replace(/\.html$/, '') : null;
  const add = document.getElementById('add-highlight');
  const remove = document.getElementById('remove-highlight');
  const retry = document.getElementById('retry-save');
  const count = document.getElementById('highlight-count');
  const message = document.getElementById('highlight-status');
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  let state;
  let ready = false;
  let highlights = [];
  let pendingHighlights = null;
  let pendingProgress = null;
  let saving = false;
  let restoring = true;
  let lastProgress = '';
  let scrollTimer;

  function setStatus(text, failed) {
    if (status) {
      status.textContent = text;
      status.classList.toggle('save-error', !!failed);
    }
    if (retry) retry.hidden = !failed || !ready;
  }

  async function request(path, options) {
    const response = await fetch(path, Object.assign({ cache: 'no-store' }, options));
    if (!response.ok) throw new Error('Folder storage unavailable (' + response.status + ').');
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  function feedback(text) {
    if (message) message.textContent = text;
  }

  function nodes() {
    const result = [];
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      result.push({ node: node, start: offset, end: offset + node.length });
      offset += node.length;
    }
    return result;
  }

  function normalize(items) {
    const text = article.textContent;
    const sorted = items.filter(function (item) {
      return item && Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end > item.start && item.end <= text.length;
    }).sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    const merged = [];
    sorted.forEach(function (item) {
      const last = merged[merged.length - 1];
      if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
      else merged.push({ start: item.start, end: item.end });
    });
    return merged.map(function (item) {
      return { start: item.start, end: item.end, quote: text.slice(item.start, item.end) };
    });
  }

  function render() {
    article.querySelectorAll('mark.study-highlight').forEach(function (mark) {
      mark.replaceWith.apply(mark, Array.from(mark.childNodes));
    });
    article.normalize();
    nodes().forEach(function (item) {
      if (item.node.parentElement.closest('button, script, style, textarea')) return;
      highlights.map(function (highlight, index) {
        return { start: Math.max(highlight.start, item.start) - item.start, end: Math.min(highlight.end, item.end) - item.start, index: index };
      }).filter(function (segment) { return segment.start < segment.end; })
        .sort(function (a, b) { return b.start - a.start; }).forEach(function (segment) {
          const range = document.createRange();
          range.setStart(item.node, segment.start);
          range.setEnd(item.node, segment.end);
          const mark = document.createElement('mark');
          mark.className = 'study-highlight';
          mark.dataset.highlightIndex = segment.index;
          mark.title = 'Click to remove highlight';
          mark.appendChild(range.extractContents());
          range.insertNode(mark);
        });
    });
    count.textContent = highlights.length + (highlights.length === 1 ? ' highlight' : ' highlights');
  }

  function selectedOffsets() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(article);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    return { start: start, end: prefix.toString().length };
  }

  function readProgress() {
    const top = article.getBoundingClientRect().top + scrollY;
    const max = Math.max(1, article.scrollHeight - Math.min(innerHeight - 110, article.scrollHeight));
    const ratio = Math.max(0, Math.min(1, (scrollY - top + 90) / max));
    const blocks = article.querySelectorAll('p, pre, li, h2, h3, h4, .cpp-section');
    let anchor = '';
    let fraction = 0;
    let firstBelow = null;
    for (const block of blocks) {
      if (!block.getClientRects().length) continue;
      const rect = block.getBoundingClientRect();
      if (rect.bottom > 90 && firstBelow === null) firstBelow = block;
      if (rect.top <= 90 && rect.bottom > 90) {
        anchor = block.dataset.readingAnchor || '';
        fraction = Math.max(0, Math.min(1, (90 - rect.top) / Math.max(1, rect.height)));
        break;
      }
    }
    if (!anchor && firstBelow) anchor = firstBelow.dataset.readingAnchor || '';
    const openSections = Array.from(document.querySelectorAll('[data-toggle-target][aria-expanded="true"]')).map(function (button) { return button.dataset.toggleTarget; });
    return { ratio: ratio, anchor: anchor, fraction: fraction, openSections: openSections };
  }

  function queueProgress(force) {
    if (!ready || restoring || document.visibilityState === 'hidden' && !force) return;
    const progress = readProgress();
    const signature = JSON.stringify(progress);
    if (!force && signature === lastProgress) return;
    lastProgress = signature;
    pendingProgress = progress;
    flush();
  }

  async function flush() {
    if (!ready || saving || pendingHighlights === null && pendingProgress === null) return;
    saving = true;
    setStatus('Saving\u2026');
    const sentHighlights = pendingHighlights;
    const sentProgress = pendingProgress;
    const patch = {};
    if (sentHighlights !== null) patch.highlights = sentHighlights;
    if (sentProgress !== null) patch.progress = sentProgress;
    try {
      await request('/api/lesson/' + encodeURIComponent(slug), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), keepalive: true });
      if (pendingHighlights === sentHighlights) pendingHighlights = null;
      if (pendingProgress === sentProgress) pendingProgress = null;
      setStatus('Saved');
    } catch (error) {
      setStatus('Not saved', true);
    } finally {
      saving = false;
    }
    if (status && status.textContent !== 'Not saved' && (pendingHighlights !== null || pendingProgress !== null)) flush();
  }

  function commit(items) {
    highlights = normalize(items);
    pendingHighlights = highlights;
    render();
    getSelection().removeAllRanges();
    feedback('');
    flush();
  }

  function restoreProgress(progress) {
    if (!progress) return;
    (progress.openSections || []).forEach(function (id) {
      const target = document.getElementById(id);
      const button = Array.from(document.querySelectorAll('[data-toggle-target]')).find(function (item) { return item.dataset.toggleTarget === id; });
      if (target && button) {
        target.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        button.textContent = button.dataset.hideLabel;
      }
    });
    if (location.hash) return;
    const target = Array.from(article.querySelectorAll('[data-reading-anchor]')).find(function (block) { return block.dataset.readingAnchor === progress.anchor; });
    if (target && target.getClientRects().length) {
      scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + scrollY + target.getBoundingClientRect().height * (progress.fraction || 0) - 90), behavior: 'instant' });
    } else {
      const top = article.getBoundingClientRect().top + scrollY;
      const max = Math.max(1, article.scrollHeight - Math.min(innerHeight - 110, article.scrollHeight));
      scrollTo({ top: Math.max(0, top - 90 + max * (progress.ratio || 0)), behavior: 'instant' });
    }
  }

  if (add) add.disabled = true;
  if (remove) remove.disabled = true;
  if (location.protocol === 'file:') {
    setStatus('Open LearnCpp.exe to save reading progress and highlights.', true);
    return;
  }
  // A server-pushed connection tracks each open document without browser storage
  // or timer heartbeats that may be suspended in background tabs.
  let lifetime = new EventSource('/api/session');
  window.addEventListener('pagehide', function () { lifetime.close(); });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      lifetime.close();
      lifetime = new EventSource('/api/session');
    }
  });
  try {
    state = await request('/api/state');
    if (state.version !== 2 || !state.lessons) throw new Error('Unexpected storage format.');
  } catch (error) {
    setStatus('Folder unavailable. Restart LearnCpp.exe.', true);
    return;
  }

  if (!article) {
    const previous = state.lastLesson && state.lessons[state.lastLesson];
    if (previous && resume) {
      const lesson = (window.LEARNCPP_SEARCH || []).find(function (item) { return item.u === state.lastLesson; });
      if (lesson) {
        resume.href = 'lessons/' + encodeURIComponent(lesson.u) + '.html';
        resume.textContent = 'Continue reading: ' + lesson.n + ' \u00b7 ' + lesson.t;
        resume.hidden = false;
      }
    }
    document.querySelectorAll('.lesson-list a').forEach(function (link) {
      const key = decodeURIComponent(link.getAttribute('href').split('/').pop()).replace(/\.html$/, '');
      const saved = state.lessons[key];
      if (saved && saved.progress) {
        const percentage = Math.round((saved.progress.ratio || 0) * 100);
        const badge = document.createElement('span');
        badge.className = 'reading-badge';
        badge.textContent = percentage >= 99 ? 'Read' : percentage + '%';
        link.appendChild(badge);
      }
    });
    setStatus('');
    return;
  }

  const saved = state.lessons[slug] || {};
  let stale = 0;
  highlights = normalize((saved.highlights || []).filter(function (item) {
    const valid = !item.quote || article.textContent.slice(item.start, item.end) === item.quote;
    if (!valid) stale++;
    return valid;
  }));
  render();
  article.querySelectorAll('p, pre, li, h2, h3, h4, .cpp-section').forEach(function (block, index) { block.dataset.readingAnchor = 'block-' + index; });
  if (stale) feedback('Some highlights no longer match this lesson. Your saved file is unchanged.');
  ready = true;
  add.disabled = false;
  remove.disabled = false;
  setStatus('Saved');
  toolbar.addEventListener('mousedown', function (event) { if (event.target.closest('button')) event.preventDefault(); });
  add.addEventListener('click', function () {
    const selected = selectedOffsets();
    if (!selected || selected.start === selected.end) return feedback('Select text first.');
    commit(highlights.concat([selected]));
  });
  remove.addEventListener('click', function () {
    const selected = selectedOffsets();
    if (!selected || selected.start === selected.end) return feedback('Select highlighted text first.');
    const remaining = [];
    highlights.forEach(function (highlight) {
      if (selected.end <= highlight.start || selected.start >= highlight.end) remaining.push(highlight);
      else {
        if (highlight.start < selected.start) remaining.push({ start: highlight.start, end: selected.start });
        if (highlight.end > selected.end) remaining.push({ start: selected.end, end: highlight.end });
      }
    });
    commit(remaining);
  });
  article.addEventListener('click', function (event) {
    const mark = event.target.closest('mark.study-highlight');
    if (!mark || !getSelection().isCollapsed) return;
    event.preventDefault();
    commit(highlights.filter(function (_, index) { return index !== Number(mark.dataset.highlightIndex); }));
  });
  retry.addEventListener('click', flush);
  window.addEventListener('scroll', function () {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () { queueProgress(false); }, 350);
  }, { passive: true });
  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-toggle-target]')) setTimeout(function () { queueProgress(true); }, 0);
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') queueProgress(true); });
  window.addEventListener('pagehide', function () {
    if (restoring) return;
    const patch = { progress: readProgress() };
    if (pendingHighlights !== null) patch.highlights = pendingHighlights;
    fetch('/api/lesson/' + encodeURIComponent(slug), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), keepalive: true }).catch(function () {});
  });
  setInterval(flush, 5000);
  const imagesReady = Array.from(article.images || article.querySelectorAll('img')).map(function (image) {
    image.loading = 'eager';
    if (image.complete) return Promise.resolve();
    return new Promise(function (resolve) { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); });
  });
  if (document.fonts) imagesReady.push(document.fonts.ready);
  await Promise.race([Promise.all(imagesReady), new Promise(function (resolve) { setTimeout(resolve, 3000); })]);
  restoreProgress(saved.progress);
  requestAnimationFrame(function () { requestAnimationFrame(function () { restoring = false; queueProgress(true); }); });
})();
