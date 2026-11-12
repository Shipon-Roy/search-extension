/**
 * ShiponLens — shared lookup-link logic.
 *
 * Loaded as a plain classic script by the service worker, content script, and
 * Options page, and required directly by the Node unit tests. Everything here
 * is pure except the small chrome.storage helpers at the bottom, which degrade
 * gracefully when chrome.storage is unavailable.
 */
(function initPixelOcrLinks(root) {
  'use strict';

  const TYPES_KEY = 'pixelOcrTypes';
  const LAST_TYPE_KEY = 'pixelOcrLastTypeId';
  const CLEANING_MODES = ['ID', 'Phone', 'Raw'];
  const NAME_MAX = 24;
  const TEMPLATE_MAX = 2048;
  const TYPES_MAX = 100;
  const DEFAULT_HOST = 'example.com';

  const DEFAULT_TYPES = [
    {
      id: 'parcel-id',
      name: 'Parcel ID',
      template: 'https://example.com/parcel/{value}',
      cleaning: 'ID',
    },
    {
      id: 'merchant-id',
      name: 'Merchant ID',
      template: 'https://example.com/merchant?id={value}',
      cleaning: 'ID',
    },
    {
      id: 'phone-number',
      name: 'Phone number',
      template: 'https://example.com/phone/{value}',
      cleaning: 'Phone',
    },
  ];

  const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';

  function getDefaultTypes() {
    return DEFAULT_TYPES.map((type) => ({ ...type }));
  }

  function generateId() {
    try {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        return root.crypto.randomUUID();
      }
    } catch {
      // Fall through.
    }
    return `type-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function createType() {
    return { id: generateId(), name: '', template: '', cleaning: 'ID' };
  }

  function toEnglishDigits(value) {
    let out = '';
    for (const ch of String(value == null ? '' : value)) {
      const index = BENGALI_DIGITS.indexOf(ch);
      out += index >= 0 ? String(index) : ch;
    }
    return out;
  }

  function isLocalHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    );
  }

  function isAllowedUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && isLocalHost(url.hostname);
    } catch {
      return false;
    }
  }

  function templateWithSample(template, sample) {
    if (template.includes('{value}')) {
      return template.split('{value}').join(encodeURIComponent(sample));
    }
    return template + encodeURIComponent(sample);
  }

  /**
   * Validates a link template.
   * @returns {{ok: true, value: string} | {ok: false, error: string}}
   */
  function validateTemplate(template) {
    if (typeof template !== 'string') {
      return { ok: false, error: 'Link template must be text.' };
    }
    const value = template.trim();
    if (!value) return { ok: false, error: 'Link template is required.' };
    if (value.length > TEMPLATE_MAX) {
      return { ok: false, error: `Link template must be at most ${TEMPLATE_MAX} characters.` };
    }
    if (/\s/.test(value)) {
      return { ok: false, error: 'Link template cannot contain spaces.' };
    }

    let url;
    try {
      url = new URL(templateWithSample(value, 'TEST123'));
    } catch {
      return { ok: false, error: 'Enter a valid absolute URL.' };
    }

    if (url.protocol === 'https:') return { ok: true, value };
    if (url.protocol === 'http:' && isLocalHost(url.hostname)) {
      return { ok: true, value };
    }
    return {
      ok: false,
      error: 'Use https://. http:// is allowed only for localhost.',
    };
  }

  /**
   * Builds the final lookup URL. The value is always URL-encoded and is never
   * treated as part of the scheme or host.
   * @returns {string|null}
   */
  function buildUrl(template, value) {
    if (typeof template !== 'string' || !template.trim()) return null;
    if (typeof value !== 'string' || !value) return null;
    const encoded = encodeURIComponent(value);
    const url = template.includes('{value}')
      ? template.split('{value}').join(encoded)
      : template.trim() + encoded;
    return isAllowedUrl(url) ? url : null;
  }

  function isValidBdMobile(value) {
    return /^01[3-9]\d{8}$/.test(String(value || ''));
  }

  /**
   * Cleans edited text according to a type's cleaning mode.
   * @returns {{value: string, usedFirstValue: boolean, invalidPhone: boolean}}
   */
  function cleanValue(text, mode) {
    const raw = typeof text === 'string' ? text : '';

    if (mode === 'Raw') {
      return { value: raw.trim(), usedFirstValue: false, invalidPhone: false };
    }

    if (mode === 'Phone') {
      const normalized = toEnglishDigits(raw);
      // Keep a plus sign that belongs to the number, even if OCR prefixed it
      // with a label such as "Phone: +880...".
      const hasPlus = /(^|[^\d])\+\s*\d/.test(normalized);
      const digits = normalized.replace(/\D/g, '');
      let value = (hasPlus ? '+' : '') + digits;

      // +8801XXXXXXXXX / 8801XXXXXXXXX -> 01XXXXXXXXX
      if (/^\+?8801\d{9}$/.test(value)) {
        value = '0' + digits.slice(3);
      }

      return {
        value,
        usedFirstValue: false,
        invalidPhone: value !== '' && !isValidBdMobile(value),
      };
    }

    // ID mode (also the safe default for an unknown mode).
    const lines = raw
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const usedFirstValue = lines.length > 1;
    const base = lines.length ? lines[0] : '';
    const value = base.replace(/\s+/g, '').replace(/[^A-Za-z0-9_-]/g, '');
    return { value, usedFirstValue, invalidPhone: false };
  }

  /** True when the edited text contains something that looks like a BD mobile. */
  function looksLikeBdPhone(text) {
    const normalized = toEnglishDigits(text)
      .replace(/[\s\-().]/g, '')
      .replace(/[^\d+]/g, '');
    return /(?:^|\D)(?:\+?880|880|0)1[3-9]\d{8}(?:\D|$)/.test(normalized);
  }

  function isPlaceholderTemplate(template) {
    const value = typeof template === 'string' ? template.trim() : '';
    if (!value) return true;
    try {
      const url = new URL(templateWithSample(value, 'TEST123'));
      return url.hostname === DEFAULT_HOST || url.hostname.endsWith(`.${DEFAULT_HOST}`);
    } catch {
      return true;
    }
  }

  function validateName(name, types, excludeId) {
    if (typeof name !== 'string') return { ok: false, error: 'Name must be text.' };
    const value = name.trim();
    if (!value) return { ok: false, error: 'Name is required.' };
    if (Array.from(value).length > NAME_MAX) {
      return { ok: false, error: `Name must be at most ${NAME_MAX} characters.` };
    }
    const key = value.toLowerCase();
    const duplicate = (types || []).some(
      (type) => type && type.id !== excludeId && String(type.name || '').trim().toLowerCase() === key,
    );
    if (duplicate) return { ok: false, error: 'Name must be unique.' };
    return { ok: true, value };
  }

  /**
   * Strict validation for saved/imported data. Returns a sanitized copy and
   * never mutates the input.
   */
  function validateTypes(input) {
    if (!Array.isArray(input)) {
      throw new Error('Types must be an array.');
    }
    if (input.length > TYPES_MAX) {
      throw new Error(`At most ${TYPES_MAX} types are supported.`);
    }

    const seenNames = new Set();
    const seenIds = new Set();
    const out = [];

    input.forEach((item, index) => {
      const label = `Type ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`${label}: must be an object.`);
      }
      if (typeof item.name !== 'string') {
        throw new Error(`${label}: name must be text.`);
      }
      const name = item.name.trim();
      if (!name) throw new Error(`${label}: name is required.`);
      if (Array.from(name).length > NAME_MAX) {
        throw new Error(`${label}: name must be at most ${NAME_MAX} characters.`);
      }
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) {
        throw new Error(`${label}: duplicate name “${name}”.`);
      }
      seenNames.add(nameKey);

      if (typeof item.cleaning !== 'string' || !CLEANING_MODES.includes(item.cleaning)) {
        throw new Error(`${label}: cleaning mode must be ID, Phone, or Raw text.`);
      }

      const templateResult = validateTemplate(item.template);
      if (!templateResult.ok) {
        throw new Error(`${label}: ${templateResult.error}`);
      }

      let id = item.id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        id = generateId();
      }
      if (seenIds.has(id)) id = generateId();
      seenIds.add(id);

      out.push({ id, name, template: templateResult.value, cleaning: item.cleaning });
    });

    return out;
  }

  /** Parses an export file. Accepts either a bare array or { types: [...] }. */
  function parseImport(text) {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch {
      throw new Error('The selected file is not valid JSON.');
    }
    if (data && !Array.isArray(data) && Array.isArray(data.types)) {
      data = data.types;
    }
    return validateTypes(data);
  }

  function exportTypes(types) {
    return JSON.stringify({ version: 1, types }, null, 2);
  }

  /* ------------------------------------------------------------------ */
  /* Storage (chrome.storage.sync, with a local fallback)                */
  /* ------------------------------------------------------------------ */

  function hasChromeStorage() {
    return (
      typeof chrome !== 'undefined' &&
      chrome &&
      chrome.storage &&
      chrome.storage.sync &&
      chrome.storage.local
    );
  }

  async function readStored(key) {
    if (!hasChromeStorage()) return undefined;
    try {
      const fromSync = await chrome.storage.sync.get(key);
      if (fromSync && fromSync[key] !== undefined) return fromSync[key];
    } catch {
      // Fall back to local.
    }
    try {
      const fromLocal = await chrome.storage.local.get(key);
      if (fromLocal && fromLocal[key] !== undefined) return fromLocal[key];
    } catch {
      // Ignore.
    }
    return undefined;
  }

  async function writeStored(key, value) {
    if (!hasChromeStorage()) throw new Error('chrome.storage is not available.');
    try {
      await chrome.storage.sync.set({ [key]: value });
      return 'sync';
    } catch {
      // Sync can reject large values (quota) or be disabled. Remove the stale
      // sync copy so a later load does not pick up older data, then use local.
      try {
        await chrome.storage.sync.remove(key);
      } catch {
        // Ignore.
      }
      await chrome.storage.local.set({ [key]: value });
      return 'local';
    }
  }

  async function removeStored(key) {
    if (!hasChromeStorage()) return;
    try {
      await chrome.storage.sync.remove(key);
    } catch {
      // Ignore.
    }
    try {
      await chrome.storage.local.remove(key);
    } catch {
      // Ignore.
    }
  }

  /** Loads the saved types, defaulting to the three shipped examples. */
  async function loadTypes() {
    const stored = await readStored(TYPES_KEY);
    if (stored === undefined) return getDefaultTypes();
    try {
      return validateTypes(stored);
    } catch {
      // Corrupt or obsolete data should not break capture; show defaults.
      return getDefaultTypes();
    }
  }

  /** Validates and saves; falls back to chrome.storage.local on sync failure. */
  async function saveTypes(types) {
    const sanitized = validateTypes(types);
    const area = await writeStored(TYPES_KEY, sanitized);
    return { types: sanitized, area };
  }

  async function loadLastTypeId() {
    const value = await readStored(LAST_TYPE_KEY);
    return typeof value === 'string' && value ? value : '';
  }

  async function saveLastTypeId(id) {
    if (typeof id !== 'string' || !id) return;
    try {
      await writeStored(LAST_TYPE_KEY, id);
    } catch {
      // Remembering the chip is best-effort.
    }
  }

  async function loadSettings() {
    const [types, lastTypeId] = await Promise.all([loadTypes(), loadLastTypeId()]);
    return { types, lastTypeId };
  }

  const api = {
    CLEANING_MODES,
    NAME_MAX,
    TEMPLATE_MAX,
    TYPES_MAX,
    TYPES_KEY,
    LAST_TYPE_KEY,
    getDefaultTypes,
    createType,
    generateId,
    toEnglishDigits,
    validateTemplate,
    buildUrl,
    isAllowedUrl,
    isValidBdMobile,
    cleanValue,
    looksLikeBdPhone,
    isPlaceholderTemplate,
    validateName,
    validateTypes,
    parseImport,
    exportTypes,
    loadTypes,
    saveTypes,
    loadLastTypeId,
    saveLastTypeId,
    loadSettings,
    hasChromeStorage,
    removeStored,
  };

  root.PixelOcrLinks = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
