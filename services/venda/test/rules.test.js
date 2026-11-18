import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstPrescription } from '../src/rules.js';

const rx = {
  customerId: 'c1',
  expiresAt: '2099-01-01T00:00:00Z',
  items: [{ sku: 'AMOXI-500', maxQty: 2 }],
  used: { 'AMOXI-500': 1 },
};

test('aceita compra dentro da receita', () => {
  assert.deepEqual(validateAgainstPrescription(rx, [{ sku: 'AMOXI-500', qty: 1 }], 'c1'), []);
});
test('bloqueia produto fora da receita, excesso, outro paciente e vencida', () => {
  assert.equal(validateAgainstPrescription(rx, [{ sku: 'OMEP-20', qty: 1 }], 'c1').length, 1);
  assert.match(validateAgainstPrescription(rx, [{ sku: 'AMOXI-500', qty: 2 }], 'c1')[0], /limite/);
  assert.match(validateAgainstPrescription(rx, [], 'c2')[0], /outro paciente/);
  assert.match(validateAgainstPrescription(rx, [], 'c1', new Date('2100-01-01'))[0], /vencida/);
});

test('rejeita quantidade zero, negativa ou fracionada', () => {
  for (const qty of [0, -5, 1.5, '1'])
    assert.match(
      validateAgainstPrescription(rx, [{ sku: 'AMOXI-500', qty }], 'c1')[0],
      /quantidade inválida/,
    );
});
