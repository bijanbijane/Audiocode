import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveMarkerAndAnnotationManager } from './LiveMarkerAndAnnotationManager';
import { TimeMath } from '../contracts/timebase.contract';

test('Section 84: LiveMarkerAndAnnotationManager compensates 550ms human reaction time and shifts markers on Ripple cuts', () => {
  const manager = new LiveMarkerAndAnnotationManager();

  // Producer hits M at 10.000s -> should compensate back by 550ms to 9.450s
  const m1 = manager.addLiveMarkerWithReactionCompensation({
    rawTriggerFlicks: TimeMath.secondsToFlicks(10.0),
    category: 'EDIT_MISTAKE_FLAG',
    noteFa: 'تپق روی نام مهمان',
  });
  assert.equal(m1.timelineFlicks, TimeMath.secondsToFlicks(9.45));
  assert.equal(m1.originalSourceFlicks, TimeMath.secondsToFlicks(9.45));

  // Marker inside a region that will be deleted (at 15.0s -> compensated to 14.45s)
  manager.addLiveMarkerWithReactionCompensation({
    rawTriggerFlicks: TimeMath.secondsToFlicks(15.0),
    category: 'FACT_CHECK_NOTE',
    noteFa: 'حذف می‌شود',
  });

  // Marker after the cut (at 25.0s -> compensated to 24.45s)
  const m3 = manager.addLiveMarkerWithReactionCompensation({
    rawTriggerFlicks: TimeMath.secondsToFlicks(25.0),
    category: 'HIGHLIGHT_QUOTE',
    noteFa: 'جمله طلایی برای تیزر',
  });

  // Ripple cut [12.0s, 17.0s] (5.0s removed) with 0.5s Room Tone injected -> net shift left = 4.5s
  const updated = manager.applyRippleCutToMarkers(
    {
      start: TimeMath.secondsToFlicks(12.0),
      end: TimeMath.secondsToFlicks(17.0),
    },
    TimeMath.secondsToFlicks(0.5),
  );

  assert.equal(updated.length, 2);
  assert.equal(updated[0].markerId, m1.markerId);
  assert.equal(updated[0].timelineFlicks, TimeMath.secondsToFlicks(9.45));

  assert.equal(updated[1].markerId, m3.markerId);
  // 24.45s - 4.5s = 19.95s on timeline, while originalSourceFlicks remains 24.45s
  assert.equal(updated[1].timelineFlicks, TimeMath.secondsToFlicks(19.95));
  assert.equal(updated[1].originalSourceFlicks, TimeMath.secondsToFlicks(24.45));
});
