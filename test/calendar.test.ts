import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calendarOccurrences} from '../src/calendar.js';

test('calendar rules retain London wall time across daylight saving transitions',()=>{
  const spring=calendarOccurrences('0 9 * * *','Europe/London',Date.parse('2026-03-28T08:59:00Z'),3).map(time=>new Date(time).toISOString());
  assert.deepEqual(spring,['2026-03-28T09:00:00.000Z','2026-03-29T08:00:00.000Z','2026-03-30T08:00:00.000Z']);
  const autumn=calendarOccurrences('0 9 * * *','Europe/London',Date.parse('2026-10-24T07:59:00Z'),3).map(time=>new Date(time).toISOString());
  assert.deepEqual(autumn,['2026-10-24T08:00:00.000Z','2026-10-25T09:00:00.000Z','2026-10-26T09:00:00.000Z']);
});
test('weekday calendar and timezone validation reject invalid rules before admission',()=>{
  assert.equal(new Date(calendarOccurrences('30 8 * * 1-5','America/New_York',Date.parse('2026-10-09T13:00:00Z'),1)[0]!).toISOString(),'2026-10-12T12:30:00.000Z');
  for(const [cron,timezone]of [['* * * * * *','UTC'],['0 25 * * *','UTC'],['0 9 * * *','Not/A_Timezone'],['0 0 31 2 *','UTC'],['H 9 * * *','UTC']])assert.throws(()=>calendarOccurrences(cron,timezone,Date.parse('2026-01-01T00:00:00Z')));
});
