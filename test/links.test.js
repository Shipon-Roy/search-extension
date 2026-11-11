'use strict';

/**
 * Plain Node tests for the shared lookup logic. No test framework required:
 *   node test/links.test.js
 */
const assert = require('assert');
const links = require('../lib/links.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

test('default types use the required order and cleaning modes', () => {
  const types = links.getDefaultTypes();
  assert.deepStrictEqual(
    types.map((t) => [t.name, t.cleaning]),
    [
      ['Parcel ID', 'ID'],
      ['Merchant ID', 'ID'],
      ['Phone number', 'Phone'],
    ],
  );
  assert.ok(types.every((t) => links.isPlaceholderTemplate(t.template)));
});

test('ID cleaning strips whitespace and disallowed characters', () => {
  assert.deepStrictEqual(links.cleanValue('  AB-12_34  ', 'ID'), {
    value: 'AB-12_34',
    usedFirstValue: false,
    invalidPhone: false,
  });
  assert.strictEqual(links.cleanValue('Parcel: ABC 123!', 'ID').value, 'ParcelABC123');
});

test('ID cleaning uses the first non-empty line and flags it', () => {
  const result = links.cleanValue('ABC123\nDEF456', 'ID');
  assert.strictEqual(result.value, 'ABC123');
  assert.strictEqual(result.usedFirstValue, true);
  assert.strictEqual(links.cleanValue('\n\n  \n', 'ID').value, '');
});

test('Raw cleaning only trims', () => {
  assert.strictEqual(links.cleanValue('  a b\nc  ', 'Raw').value, 'a b\nc');
});

test('phone cleaning normalizes all three required formats', () => {
  for (const input of ['+880 1712-345678', '8801712345678', '০১৭১২৩৪৫৬৭৮']) {
    const result = links.cleanValue(input, 'Phone');
    assert.strictEqual(result.value, '01712345678', input);
    assert.strictEqual(result.invalidPhone, false, input);
  }
});

test('phone cleaning strips labels and punctuation', () => {
  assert.strictEqual(links.cleanValue('Phone: +880 (17) 1234.5678', 'Phone').value, '01712345678');
  assert.strictEqual(links.cleanValue('+1 (555) 010-9999', 'Phone').value, '+15550109999');
});

test('phone cleaning warns about non-BD values but keeps them', () => {
  const result = links.cleanValue('+1 555 010 9999', 'Phone');
  assert.strictEqual(result.value, '+15550109999');
  assert.strictEqual(result.invalidPhone, true);
});

test('BD phone detection works on edited-looking text', () => {
  assert.strictEqual(links.looksLikeBdPhone('call +880 1712-345678 now'), true);
  assert.strictEqual(links.looksLikeBdPhone('০১৭১২৩৪৫৬৭৮'), true);
  assert.strictEqual(links.looksLikeBdPhone('order ABC123'), false);
  assert.strictEqual(links.looksLikeBdPhone('123456789012345'), false);
});

test('templates append value when no placeholder exists', () => {
  assert.strictEqual(
    links.buildUrl('https://x.test/parcel/', 'ABC123'),
    'https://x.test/parcel/ABC123',
  );
});

test('templates replace {value} anywhere and URL-encode it', () => {
  assert.strictEqual(
    links.buildUrl('https://x.test/merchant?id={value}', 'M-77'),
    'https://x.test/merchant?id=M-77',
  );
  assert.strictEqual(
    links.buildUrl('https://x.test/search?q={value}&type=parcel', 'A B/C'),
    'https://x.test/search?q=A%20B%2FC&type=parcel',
  );
});

test('templates reject non-https except localhost', () => {
  assert.strictEqual(links.validateTemplate('https://x.test/a/{value}').ok, true);
  assert.strictEqual(links.validateTemplate('http://localhost:3000/a/{value}').ok, true);
  assert.strictEqual(links.validateTemplate('http://127.0.0.1/a/').ok, true);
  assert.strictEqual(links.validateTemplate('http://x.test/a/').ok, false);
  assert.strictEqual(links.validateTemplate('javascript:alert(1)').ok, false);
  assert.strictEqual(links.validateTemplate('not a url').ok, false);
  assert.strictEqual(links.validateTemplate('').ok, false);
});

test('buildUrl refuses empty values and unsafe schemes', () => {
  assert.strictEqual(links.buildUrl('https://x.test/', ''), null);
  assert.strictEqual(links.buildUrl('javascript:alert(1)', 'ABC'), null);
  assert.strictEqual(links.buildUrl('http://x.test/', 'ABC'), null);
});

test('placeholder templates are detected', () => {
  assert.strictEqual(links.isPlaceholderTemplate('https://example.com/parcel/{value}'), true);
  assert.strictEqual(links.isPlaceholderTemplate('https://x.test/parcel/'), false);
  assert.strictEqual(links.isPlaceholderTemplate(''), true);
});

test('validateTypes rejects duplicates, bad lengths, and bad modes', () => {
  const base = { id: 'a', name: 'A', template: 'https://x.test/', cleaning: 'ID' };
  assert.throws(() => links.validateTypes([base, { ...base, id: 'b' }]), /duplicate name/i);
  assert.throws(
    () => links.validateTypes([{ ...base, name: 'x'.repeat(25) }]),
    /at most 24/i,
  );
  assert.throws(() => links.validateTypes([{ ...base, cleaning: 'Nope' }]), /cleaning mode/i);
  assert.throws(
    () => links.validateTypes([{ ...base, template: 'http://x.test/' }]),
    /https/i,
  );
});

test('validateTypes sanitizes and preserves stable ids', () => {
  const out = links.validateTypes([
    { id: 'keep-me', name: ' Parcel ', template: ' https://x.test/p/ ', cleaning: 'ID' },
  ]);
  assert.deepStrictEqual(out, [
    { id: 'keep-me', name: 'Parcel', template: 'https://x.test/p/', cleaning: 'ID' },
  ]);
});

test('export/import restores exactly the same types', () => {
  const types = links.validateTypes([
    { id: 'one', name: 'Order ID', template: 'https://x.test/order/', cleaning: 'ID' },
    { id: 'two', name: 'Phone', template: 'https://x.test/p/{value}', cleaning: 'Phone' },
  ]);
  const text = links.exportTypes(types);
  assert.deepStrictEqual(links.parseImport(text), types);
});

test('malformed imports are rejected', () => {
  assert.throws(() => links.parseImport('{not json'), /valid JSON/i);
  assert.throws(() => links.parseImport('{"types": "nope"}'), /array/i);
  assert.throws(
    () => links.parseImport('[{"name":"A","template":"javascript:x","cleaning":"ID"}]'),
    /https|URL/i,
  );
});

test('import accepts a bare array and up to 100 types', () => {
  const bare = links.parseImport(
    '[{"name":"A","template":"https://x.test/a/","cleaning":"Raw"}]',
  );
  assert.strictEqual(bare.length, 1);
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `id-${i}`,
    name: `Type ${i}`,
    template: `https://x.test/${i}/`,
    cleaning: 'ID',
  }));
  assert.strictEqual(links.validateTypes(many).length, 20);
});

test('unknown cleaning mode is not silently changed', () => {
  assert.throws(
    () =>
      links.validateTypes([
        { name: 'A', template: 'https://x.test/', cleaning: 'raw' },
      ]),
    /cleaning mode/i,
  );
});

console.log(`\n${passed} tests passed`);
