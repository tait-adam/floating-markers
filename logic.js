// Floating Markers: logic that does not touch the DOM, so tests can exercise it against Luna.MockEngine.
//
// Everything here takes SDK objects (a Luna.Session, a Luna.Marker) and returns plain data or
// performs an engine action. main.js turns the data into DOM.

const AddOnLogic = {
  /** A packed ARGB colour as CSS `#rrggbb`, or null when the marker has none. */
  colorCss(argb) {
    if (typeof argb !== 'number') return null;
    return '#' + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  },

  /** Rows for every marker in timeline order, numbered from 1 as the number keys address them. */
  rows(session) {
    return session.markers.sorted.map((m, i) => ({
      id: m.id,
      number: i + 1,
      name: m.name.value || `Marker ${i + 1}`,
      position: Luna.formatBarBeat(m.barBeat.value),
      color: AddOnLogic.colorCss(m.color.value),
    }));
  },

  /** The id of the marker the playhead is at or past, or undefined before the first. */
  currentId(session) {
    return session.markers.at(session.transport.tick)?.id;
  },

  /** Move the playhead to a marker. */
  async jumpTo(session, marker) {
    await session.transport.seek(marker.location.value);
  },

  /**
   * The range from the earlier marker's start to the end of the later one's section, where
   * the next marker begins. The last marker has no section end, so with it the range stops at
   * the later marker itself (or covers nothing, when both are the last). Ticks.
   */
  sectionRange(session, a, b) {
    const sorted = session.markers.sorted;
    const [first, last] = [sorted.indexOf(a), sorted.indexOf(b)].sort((x, y) => x - y);
    const start = sorted[first].location.value;
    const next = sorted[last + 1];
    const stop = next ? next.location.value : sorted[last].location.value;
    return { start, stop, open: !next };
  },

  /**
   * Shift-click: select the sections from one marker to another and loop playback over them,
   * starting from the top of the loop. Answers the range, or null when it is empty.
   */
  async loopBetween(session, a, b) {
    const range = AddOnLogic.sectionRange(session, a, b);
    if (range.stop <= range.start) return null;
    const t = session.transport;
    await t.setLoop(range.start, range.stop);
    await session.context.select({ startTick: range.start, stopTick: range.stop });
    if (t.looping.value !== true) await t.looping.set(true);
    await t.setPlayStart(range.start);
    return range;
  },

  /** Move the playhead to marker `number` (1-based, timeline order). False when there is none. */
  async jumpToNumber(session, number) {
    const marker = session.markers.sorted[number - 1];
    if (!marker) return false;
    await AddOnLogic.jumpTo(session, marker);
    return true;
  },

  /**
   * Numpad 0: stop, and pressed again once stopped, go back to the start (LUNA's Return To
   * Zero), as Return does in Pro Tools. Answers what it did.
   */
  async stopOrRewind(session) {
    const t = session.transport;
    if (t.playing.value) {
      await t.stop();
      return 'stop';
    }
    await t.returnToZero();
    return 'rewind';
  },

  /** Numpad Enter: play from the play start. */
  async play(session) {
    if (!session.transport.playing.value) await session.transport.play();
  },

  /** Delete markers as one undo step. */
  async deleteMarkers(session, markers) {
    if (markers.length === 0) return;
    await session.transaction(markers.length === 1 ? 'Delete Marker' : 'Delete Markers', async () => {
      for (const m of markers) await m.delete();
    });
  },

  /** Rename a marker; a blank or unchanged name does nothing. False when nothing changed. */
  async rename(marker, name) {
    const next = name.trim();
    if (!next || next === marker.name.value) return false;
    await marker.rename(next);
    return true;
  },

  /**
   * Number keys jump to markers: 1 to the first, 2 to the second. A digit typed within
   * `windowMs` of the last one carries on the number when that marker exists, so 1 then 2
   * goes to marker 1 and then on to 12. `key(digit, count, now)` answers the marker number
   * to jump to, or null for a 0 that starts no number (numpad 0 is stop).
   */
  createNumberKeys(windowMs = 800) {
    let last = null;
    let at = -Infinity;
    return {
      reset() {
        last = null;
      },
      key(digit, count, now) {
        const longer = last !== null && now - at <= windowMs ? last * 10 + digit : null;
        const number = longer !== null && longer <= count ? longer : digit;
        if (number === 0) return null;
        last = number;
        at = now;
        return number;
      },
    };
  },
};

globalThis.AddOnLogic = AddOnLogic;
