import test from 'node:test';
import assert from 'node:assert/strict';
import { selectResume } from '../public/floating-resume.js';

test('resume stays in its header until its original position scrolls out of view', () => {
  assert.deepEqual(selectResume(100, 900, [{ top: 100, bottom: 2000, anchorBottom: 180, disabled: false }]), {
    index: 0,
    floating: false,
  });
  assert.deepEqual(selectResume(100, 900, [{ top: -100, bottom: 1800, anchorBottom: 80, disabled: false }]), {
    index: 0,
    floating: true,
  });
  assert.deepEqual(selectResume(100, 900, [{ top: 80, bottom: 2000, anchorBottom: 160, disabled: false }]), {
    index: 0,
    floating: false,
  });
});

test('resume follows the conversation being read instead of an earlier session', () => {
  const earlier = { top: -1200, bottom: 120, anchorBottom: -1100, disabled: false };
  assert.deepEqual(
    selectResume(100, 900, [earlier, { top: 120, bottom: 1500, anchorBottom: 200, disabled: false }]),
    { index: 1, floating: false },
  );
  assert.deepEqual(
    selectResume(100, 900, [earlier, { top: 20, bottom: 1500, anchorBottom: 90, disabled: false }]),
    { index: 1, floating: true },
  );
});

test('an unreadable or loading conversation never offers a previous conversation’s command', () => {
  assert.equal(
    selectResume(100, 900, [
      { top: -1200, bottom: 120, anchorBottom: -1100, disabled: false },
      { top: 120, bottom: 1500, anchorBottom: 90, disabled: true },
    ]),
    null,
  );
});

test('empty, hidden, and offscreen feeds have no floating resume action', () => {
  assert.equal(selectResume(100, 900, []), null);
  assert.equal(selectResume(100, 100, [{ top: 0, bottom: 1000, anchorBottom: 0, disabled: false }]), null);
  assert.equal(
    selectResume(100, 900, [{ top: 1000, bottom: 2000, anchorBottom: 1050, disabled: false }]),
    null,
  );
  assert.equal(
    selectResume(100, 900, [{ top: -1000, bottom: 80, anchorBottom: -950, disabled: false }]),
    null,
  );
});
