// ---- DOM refs ----
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const list = document.getElementById('suggestions');
const spinner = document.getElementById('spinner');
const errorEl = document.getElementById('error');
const responseEl = document.getElementById('response');
const searchBtn = document.getElementById('search-btn');
const recencyToggle = document.getElementById('recency-toggle');
const trendingList = document.getElementById('trending-list');

const DEBOUNCE_MS = 180;

// Toggle ON -> mode=trending (recency-aware), OFF -> mode=basic (all-time count).
function currentMode() {
  return recencyToggle.checked ? 'trending' : 'basic';
}

let debounceTimer = null;
let activeController = null; // current in-flight fetch ka AbortController
let reqSeq = 0;             // monotonic sequence -> stale response guard
let items = [];            // current suggestions data
let activeIndex = -1;      // keyboard highlight index (-1 = kuch highlight nahi)

// ---------- rendering ----------

function hideDropdown() {
  list.hidden = true;
  list.innerHTML = '';
  items = [];
  activeIndex = -1;
  input.setAttribute('aria-expanded', 'false');
}

function showError() {
  errorEl.hidden = false;
}
function clearError() {
  errorEl.hidden = true;
}

// Typed prefix ke baad ka hissa bold -> user ko match clearly dikhe.
function renderText(query, prefix) {
  const el = document.createElement('span');
  el.className = 'text';
  if (prefix && query.toLowerCase().startsWith(prefix.toLowerCase())) {
    const matched = document.createTextNode(query.slice(0, prefix.length));
    const rest = document.createElement('b');
    rest.textContent = query.slice(prefix.length);
    el.appendChild(matched);
    el.appendChild(rest);
  } else {
    el.textContent = query;
  }
  return el;
}

function renderSuggestions(suggestions, prefix) {
  list.innerHTML = '';
  items = suggestions;
  activeIndex = -1;

  if (suggestions.length === 0) {
    // Zero matches -> calm "No suggestions", not an error.
    const li = document.createElement('li');
    li.className = 'suggestion empty';
    li.textContent = 'No suggestions';
    list.appendChild(li);
  } else {
    suggestions.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'suggestion';
      li.setAttribute('role', 'option');
      li.appendChild(renderText(s.query, prefix));

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = s.count.toLocaleString();
      li.appendChild(count);

      // Mouse click -> input fill + close.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // input ka blur na ho jab tak select complete
        selectSuggestion(i);
      });
      li.addEventListener('mouseenter', () => setActive(i));
      list.appendChild(li);
    });
  }

  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function setActive(index) {
  const rows = list.querySelectorAll('.suggestion:not(.empty)');
  rows.forEach((r) => r.classList.remove('active'));
  activeIndex = index;
  if (index >= 0 && rows[index]) {
    rows[index].classList.add('active');
    rows[index].scrollIntoView({ block: 'nearest' });
  }
}

// ---------- fetching ----------

async function fetchSuggestions(prefix) {
  // Stale-response guard: har naye request ka apna seq; purana response naya ko overwrite na kare.
  const seq = ++reqSeq;

  // Pichla in-flight request cancel -> bandwidth + out-of-order dono se bachte hain.
  if (activeController) activeController.abort();
  activeController = new AbortController();

  spinner.hidden = false;
  clearError();

  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(prefix)}&mode=${currentMode()}`, {
      signal: activeController.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Agar beech me naya request aa gaya to is purane response ko discard kar do.
    if (seq !== reqSeq) return;

    spinner.hidden = true;
    renderSuggestions(data.suggestions || [], prefix);
  } catch (err) {
    if (err.name === 'AbortError') return; // intentionally cancelled, ignore
    if (seq !== reqSeq) return;
    // Network/500 -> inline error, spinner band, infinite spin nahi.
    spinner.hidden = true;
    hideDropdown();
    showError();
  }
}

// ---------- input handling ----------

input.addEventListener('input', () => {
  const value = input.value.trim();
  clearError();

  // Empty input -> dropdown clear, koi fetch nahi.
  if (!value) {
    if (activeController) activeController.abort();
    reqSeq++; // pending responses invalidate
    spinner.hidden = true;
    hideDropdown();
    return;
  }

  // Debounce: har keystroke pe call mat karo, typing ruke tab fire karo (~180ms).
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => fetchSuggestions(value), DEBOUNCE_MS);
});

// ---------- keyboard nav ----------

input.addEventListener('keydown', (e) => {
  const rows = items.length; // empty/no-match pe navigation nahi

  if (e.key === 'ArrowDown') {
    if (!rows || list.hidden) return;
    e.preventDefault();
    setActive((activeIndex + 1) % rows); // wrap-around
  } else if (e.key === 'ArrowUp') {
    if (!rows || list.hidden) return;
    e.preventDefault();
    setActive((activeIndex - 1 + rows) % rows);
  } else if (e.key === 'Enter') {
    // Enter WITH highlight -> us suggestion ko fill + submit (Phase 2 ka fill-only upgrade).
    // Enter WITHOUT highlight -> form submit handler plain text submit karega.
    if (activeIndex >= 0 && rows) {
      e.preventDefault();
      selectSuggestion(activeIndex);
    }
  } else if (e.key === 'Escape') {
    hideDropdown();
  }
});

// Selection: input fill + dropdown band + ab search bhi submit (Phase 2 ka fill-only upgrade —
// suggestion choose karna matlab usse search karna, real typeahead jaisa).
function selectSuggestion(index) {
  if (!items[index]) return;
  const query = items[index].query;
  input.value = query;
  hideDropdown();
  submitSearch(query);
}

// Bahar click -> dropdown band.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-area')) hideDropdown();
});

// ---------- search submission ----------

function showResponse(html, isError) {
  responseEl.innerHTML = html;
  responseEl.classList.toggle('is-error', !!isError);
  responseEl.hidden = false;
}

function setSubmitting(on) {
  searchBtn.disabled = on;
  searchBtn.textContent = on ? 'Searching…' : 'Search';
}

// Phase 3: ab actual POST /search, dummy 'Searched' response dikhao.
async function submitSearch(query) {
  const q = (query || '').trim();
  // Empty input pe backend call mat karo, sirf calm hint.
  if (!q) {
    showResponse('Type something to search.', false);
    return;
  }

  setSubmitting(true);
  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Dummy "Searched" message + normalized query + naya count dikhao.
    showResponse(
      `<span class="badge">${data.message}</span>` +
        `<span class="q">${data.query}</span>` +
        `<span class="meta"> · count ${data.count}</span>`,
      false
    );
  } catch (err) {
    // Network/500 -> inline error, button reset (no stuck spinner).
    showResponse('Search failed. Please try again.', true);
  } finally {
    setSubmitting(false);
  }
}

// Search button / Enter-with-no-highlight -> form submit -> submitSearch.
form.addEventListener('submit', (e) => {
  e.preventDefault();
  hideDropdown();
  submitSearch(input.value.trim());
});

// Toggle badalne pe current prefix ko naye mode me turant re-fetch -> basic vs trending live dikhe.
recencyToggle.addEventListener('change', () => {
  const value = input.value.trim();
  if (value) fetchSuggestions(value);
});

// ---------- trending section (Phase 5) ----------

function renderTrending(list) {
  trendingList.innerHTML = '';
  if (!list || list.length === 0) {
    const li = document.createElement('li');
    li.className = 'trending-empty';
    li.textContent = 'No trending searches yet — try searching something.';
    trendingList.appendChild(li);
    return;
  }
  list.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'trending-item';
    li.innerHTML =
      `<span class="rank">#${i + 1}</span>` +
      `<span class="t-query"></span>` +
      `<span class="t-score">${t.score}</span>`;
    li.querySelector('.t-query').textContent = t.query;
    // Clicking a trending item fills box + submits (reuse search submission).
    li.addEventListener('click', () => {
      input.value = t.query;
      submitSearch(t.query);
    });
    trendingList.appendChild(li);
  });
}

// Phase 5: trending list ab /trending se aati hai.
async function loadTrending() {
  try {
    const res = await fetch('/trending');
    if (!res.ok) return;
    const data = await res.json();
    renderTrending(data.trending || []);
  } catch (err) {
    /* trending list optional hai — fail ho to chup-chaap chhod do */
  }
}

loadTrending();
setInterval(loadTrending, 20000); // har ~20s refresh (trending jaldi badalta hai)
