// test/age_gate.test.js - Age boundary and regional geofencing tests
import test from 'node:test';
import assert from 'node:assert/strict';

function calculateAge(birthDateString, referenceDate = new Date('2026-10-25')) {
  const birthDate = new Date(birthDateString);
  let age = referenceDate.getFullYear() - birthDate.getFullYear();
  const monthDiff = referenceDate.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

const SUPPORTED_REGIONS = new Set(['TN', 'PY', 'KA', 'KL']);

function evaluateEligibility(dobString, stateCode, referenceDate) {
  const age = calculateAge(dobString, referenceDate);
  if (isNaN(age) || age < 21) {
    return { eligible: false, reason: 'AGE_BELOW_21', age };
  }
  if (!SUPPORTED_REGIONS.has(stateCode)) {
    return { eligible: false, reason: 'REGION_NOT_SUPPORTED', age };
  }
  return { eligible: true, age };
}

test('Age Gate: Under 21 is strictly rejected', () => {
  // Born 2005-10-26 is 20 years old on 2026-10-25
  const result = evaluateEligibility('2005-10-26', 'TN', new Date('2026-10-25'));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'AGE_BELOW_21');
  assert.equal(result.age, 20);
});

test('Age Gate: Exactly 21 years old is eligible', () => {
  // Born 2005-10-25 is exactly 21 years old on 2026-10-25
  const result = evaluateEligibility('2005-10-25', 'TN', new Date('2026-10-25'));
  assert.equal(result.eligible, true);
  assert.equal(result.age, 21);
});

test('Age Gate: 25 years old is eligible', () => {
  const result = evaluateEligibility('2001-05-15', 'KA', new Date('2026-10-25'));
  assert.equal(result.eligible, true);
  assert.equal(result.age, 25);
});

test('Age Gate: Supported regions (TN, PY, KA, KL) are accepted', () => {
  for (const region of ['TN', 'PY', 'KA', 'KL']) {
    const res = evaluateEligibility('2000-01-01', region, new Date('2026-10-25'));
    assert.equal(res.eligible, true, `Region ${region} should be accepted`);
  }
});

test('Age Gate: Unsupported regions (e.g. DL, MH) are rejected', () => {
  for (const region of ['DL', 'MH', 'OTHER', '']) {
    const res = evaluateEligibility('2000-01-01', region, new Date('2026-10-25'));
    assert.equal(res.eligible, false);
    assert.equal(res.reason, 'REGION_NOT_SUPPORTED');
  }
});
