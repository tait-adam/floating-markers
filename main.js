// Floating Markers: DOM wiring. Connects to LUNA, follows the focused session, and renders what
// logic.js computes. Every listener is kept so it can be released when the session changes.

const $ = (id) => document.getElementById(id);
let luna;
let session;
let releases = [];
const keep = (u) => releases.push(u);
const release = () => {
  for (const u of releases) u();
  releases = [];
};
// Per-marker listeners, cleared whenever the list is rebuilt.
const bindings = new Luna.Bindings();
// As a panel LUNA titles it in its own header, so the page's heading is only for the window.
document.body.dataset.target = Luna.addOnTarget() ?? 'window';
const numberKeys = AddOnLogic.createNumberKeys();
let flashTimer;
let currentId;
// A plain click selects one marker and is the anchor; a shift-click selects (and loops) from
// the anchor to the marker clicked.
let anchor;
let selectedIds = new Set();
let looping = false;

function flash(text, ms = 900) {
  const el = $('entry');
  el.textContent = text;
  el.classList.toggle('show', text !== '');
  clearTimeout(flashTimer);
  if (text) flashTimer = setTimeout(() => flash(''), ms);
}

function paintCurrent() {
  const id = AddOnLogic.currentId(session);
  if (id === currentId) return;
  currentId = id;
  for (const li of $('markers').children) li.classList.toggle('current', li.dataset.id === id);
}

function paintSelection() {
  for (const li of $('markers').children) {
    const on = selectedIds.has(li.dataset.id);
    li.classList.toggle('selected', on);
    li.classList.toggle('looped', on && looping);
  }
}

function select(ids, loop = false) {
  selectedIds = new Set(ids);
  looping = loop;
  paintSelection();
}

function renderMarkers() {
  bindings.clear();
  const root = $('markers');
  root.innerHTML = '';
  const rows = AddOnLogic.rows(session);
  $('empty').hidden = rows.length > 0;
  // Drop deleted markers from the selection.
  selectedIds = new Set([...selectedIds].filter((id) => session.markers.byId(id)));
  if (anchor && !session.markers.byId(anchor.id)) anchor = undefined;
  for (const row of rows) {
    const li = document.createElement('li');
    li.dataset.id = row.id;
    li.title = `${row.name}: click or numpad ${row.number} to jump, shift-click to loop, double-click the name to rename`;
    li.innerHTML = `<span class="num"></span><span class="swatch"></span><span class="name"></span><span class="pos"></span>`;
    li.querySelector('.num').textContent = row.number;
    li.querySelector('.name').textContent = row.name;
    li.querySelector('.pos').textContent = row.position;
    const swatch = li.querySelector('.swatch');
    if (row.color) swatch.style.background = row.color;
    else swatch.classList.add('none');
    const marker = session.markers.byId(row.id);
    li.onclick = (e) => clickMarker(marker, e.shiftKey);
    li.querySelector('.name').ondblclick = (e) => {
      e.stopPropagation();
      startRename(marker);
    };
    root.appendChild(li);
    // A rename, recolour or move re-sorts and renumbers, so rebuild the list.
    for (const prop of [marker.name, marker.color, marker.barBeat]) {
      bindings.on(prop, () => bindings.whenIdle(renderMarkers));
    }
  }
  currentId = undefined;
  paintCurrent();
  paintSelection();
}

async function clickMarker(marker, shift) {
  if (shift && anchor) {
    const sorted = session.markers.sorted;
    const [i, j] = [sorted.indexOf(anchor), sorted.indexOf(marker)].sort((x, y) => x - y);
    const range = await AddOnLogic.loopBetween(session, anchor, marker);
    select(sorted.slice(i, j + 1).map((m) => m.id), range !== null);
    flash(range ? `loop ${i + 1}–${j + 1}` : 'nothing to loop', 1200);
    return;
  }
  anchor = marker;
  select([marker.id]);
  await AddOnLogic.jumpTo(session, marker);
}

// Inline rename: Enter or leaving the field saves, Escape cancels. The hold keeps the list
// from being rebuilt under the field while it is open.
function startRename(marker) {
  const li = [...$('markers').children].find((el) => el.dataset.id === marker.id);
  const label = li?.querySelector('.name');
  if (!label) return;
  const done = bindings.hold();
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = marker.name.value ?? '';
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save) await AddOnLogic.rename(marker, input.value);
    input.replaceWith(label);
    done();
    bindings.whenIdle(renderMarkers);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  input.onblur = () => finish(true);
  input.onclick = input.ondblclick = (e) => e.stopPropagation();
}

async function bindSession() {
  release();
  bindings.clear();
  numberKeys.reset();
  flash('');
  anchor = undefined;
  selectedIds = new Set();
  looping = false;
  session = luna.sessions.current();
  if (!session) {
    $('status').textContent = 'no session open';
    $('markers').innerHTML = '';
    return;
  }
  await session.ready();
  $('status').textContent = session.name.value ?? session.uid;
  await Promise.all([session.markers.membersReady(), session.musical.ready()]);
  renderMarkers();
  keep(session.markers.onChange(() => bindings.whenIdle(renderMarkers)));
  keep(session.transport.location.onChange(paintCurrent));
}

// Numpad 1-9 act like clicking that marker (digits in quick succession reach 10 and up), and
// with shift like a shift-click; numpad Enter plays, numpad 0 stops and then rewinds, Backspace
// or Delete removes the selected markers. Keys handled here are kept from LUNA with
// preventDefault(); everything else, the number row included, goes on to LUNA's shortcuts.
document.addEventListener('keydown', async (e) => {
  if (!session || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;

  if (e.code === 'NumpadEnter') {
    e.preventDefault();
    await AddOnLogic.play(session);
    return;
  }

  const numpad = /^Numpad([0-9])$/.exec(e.code);
  if (numpad) {
    e.preventDefault();
    const number = numberKeys.key(Number(numpad[1]), session.markers.items.length, performance.now());
    if (number === null) {
      const did = await AddOnLogic.stopOrRewind(session);
      if (did === 'rewind') flash('⏮');
      return;
    }
    const target = session.markers.sorted[number - 1];
    if (!target) {
      flash(`no marker ${number}`);
      return;
    }
    // Same as a click: shift selects and loops from the anchor, without it the key jumps.
    if (!e.shiftKey || !anchor) flash(String(number));
    await clickMarker(target, e.shiftKey);
    return;
  }

  if ((e.key === 'Backspace' || e.key === 'Delete') && selectedIds.size > 0) {
    e.preventDefault();
    const doomed = [...selectedIds].map((id) => session.markers.byId(id)).filter(Boolean);
    selectedIds = new Set();
    looping = false;
    anchor = undefined;
    flash(doomed.length === 1 ? 'marker deleted' : `${doomed.length} markers deleted`);
    await AddOnLogic.deleteMarkers(session, doomed);
  }
});

// Keys typed into LUNA's main window never reach this page, so the number keys work only
// while it has focus. Show whether it does, and take focus when the mouse comes over it.
// Keys the page does not claim still go on to LUNA's shortcuts.
const paintFocus = () => $('keys').classList.toggle('on', document.hasFocus());
window.addEventListener('focus', paintFocus);
window.addEventListener('blur', paintFocus);
document.addEventListener('mouseenter', () => {
  window.focus();
  paintFocus();
});
paintFocus();

async function connect() {
  for (;;) {
    try {
      // Inside LUNA the page URL carries ?port=; in a browser this falls back to LUNA on
      // localhost.
      luna = await Luna.connect();
      break;
    } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'waiting for LUNA...' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's standard undo, redo, play and record keys, for any key this page does not handle.
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') $('status').textContent = 'reconnecting...';
  });
  await bindSession();
}

connect();
