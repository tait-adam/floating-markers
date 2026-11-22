// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const logic = globalThis.AddOnLogic;

const BAR = Luna.WHOLE_NOTE;

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.musical.ready();
  // Added out of order: the list follows the timeline, not creation order.
  await session.addMarker(BAR * 8, 'Chorus', { color: 0xffff0000 });
  await session.addMarker(BAR * 0, 'Intro', { color: 0xff00ff80 });
  await session.addMarker(BAR * 4, 'Verse');
  await engine.settled();
  await luna.settled();
  return { engine, luna, session };
}

describe('Floating Markers', () => {
  it('lists markers in timeline order, numbered from 1, with colours', async () => {
    const { session } = await connected();
    const rows = logic.rows(session);
    expect(rows.map((r) => [r.number, r.name])).toEqual([[1, 'Intro'], [2, 'Verse'], [3, 'Chorus']]);
    expect(rows[0].color).toBe('#00ff80');
    expect(rows[2].color).toBe('#ff0000');
    expect(rows[2].position).toBe(Luna.formatBarBeat(session.markers.sorted[2].barBeat.value));
  });

  it('converts packed ARGB to CSS', () => {
    expect(logic.colorCss(0xff3366cc)).toBe('#3366cc');
    expect(logic.colorCss(0x000000ff)).toBe('#0000ff');
    expect(logic.colorCss(undefined)).toBe(null);
  });

  it('moves the playhead to a clicked marker', async () => {
    const { engine, session } = await connected();
    await logic.jumpTo(session, session.markers.sorted[2]);
    await engine.settled();
    expect(session.transport.tick).toBe(BAR * 8);
    expect(logic.currentId(session)).toBe(session.markers.sorted[2].id);
  });

  it('jumps by marker number and refuses one that does not exist', async () => {
    const { engine, session } = await connected();
    expect(await logic.jumpToNumber(session, 2)).toBe(true);
    await engine.settled();
    expect(session.transport.tick).toBe(BAR * 4);
    expect(await logic.jumpToNumber(session, 9)).toBe(false);
    expect(await logic.jumpToNumber(session, 0)).toBe(false);
    expect(session.transport.tick).toBe(BAR * 4);
  });

  it('loops from the earlier marker to the end of the later one, in either click order', async () => {
    const { engine, session } = await connected();
    const [intro, verse, chorus] = session.markers.sorted;
    // Intro (bar 0) shift-click Verse (bar 4): Verse's section ends at Chorus (bar 8).
    expect(await logic.loopBetween(session, verse, intro)).toMatchObject({ start: 0, stop: BAR * 8 });
    await engine.settled();
    const t = session.transport;
    expect([t.loopStart.value, t.loopStop.value, t.looping.value]).toEqual([0, BAR * 8, true]);
    expect(t.playStart.value).toBe(0);
    expect([session.context.selectionStart.value, session.context.selectionStop.value]).toEqual([0, BAR * 8]);
    // Chorus is last, so it has no section end: the loop stops at Chorus.
    expect(logic.sectionRange(session, intro, chorus)).toEqual({ start: 0, stop: BAR * 8, open: true });
    expect(await logic.loopBetween(session, chorus, chorus)).toBe(null);
    // A single section: Verse to Verse loops bar 4 to bar 8.
    expect(logic.sectionRange(session, verse, verse)).toEqual({ start: BAR * 4, stop: BAR * 8, open: false });
  });

  it('plays on Enter, and 0 stops then rewinds to the start', async () => {
    const { engine, session } = await connected();
    const t = session.transport;
    await t.seek(BAR * 4);
    await logic.play(session);
    await engine.settled();
    expect(t.playing.value).toBe(true);
    expect(await logic.stopOrRewind(session)).toBe('stop');
    await engine.settled();
    expect(t.playing.value).toBe(false);
    expect(t.playStart.value).toBe(BAR * 4);
    expect(await logic.stopOrRewind(session)).toBe('rewind');
    await engine.settled();
    expect(t.playStart.value).toBe(0);
  });

  it('deletes several markers as one undo step', async () => {
    const { engine, session } = await connected();
    const [intro, , chorus] = session.markers.sorted;
    await logic.deleteMarkers(session, [intro, chorus]);
    await engine.settled();
    expect(logic.rows(session).map((r) => r.name)).toEqual(['Verse']);
    expect(engine.transactions).toEqual(['begin', 'commit']);
  });

  it('renames a marker, ignoring a blank or unchanged name', async () => {
    const { engine, session } = await connected();
    const verse = session.markers.sorted[1];
    expect(await logic.rename(verse, '  Verse 1 ')).toBe(true);
    await engine.settled();
    expect(verse.name.value).toBe('Verse 1');
    expect(await logic.rename(verse, '   ')).toBe(false);
    expect(await logic.rename(verse, 'Verse 1')).toBe(false);
    expect(verse.name.value).toBe('Verse 1');
  });

  it('turns number keys into marker numbers', () => {
    const keys = logic.createNumberKeys(800);
    expect(keys.key(3, 5, 0)).toBe(3);
    expect(keys.key(1, 5, 2000)).toBe(1);
    expect(keys.key(2, 5, 2100)).toBe(2); // 12 does not exist with 5 markers
    expect(keys.key(1, 15, 5000)).toBe(1);
    expect(keys.key(2, 15, 5300)).toBe(12); // quick second digit carries on
    expect(keys.key(4, 15, 9000)).toBe(4); // too slow: a fresh number
    expect(keys.key(0, 15, 20000)).toBe(null); // a lone 0 is stop
    expect(keys.key(1, 15, 30000)).toBe(1);
    expect(keys.key(0, 15, 30200)).toBe(10);
  });
});
