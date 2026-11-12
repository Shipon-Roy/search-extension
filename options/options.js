'use strict';

(() => {
  const Links = window.PixelOcrLinks;
  if (!Links) {
    throw new Error('Shared link logic failed to load.');
  }

  const rowsEl = document.getElementById('rows');
  const emptyEl = document.getElementById('empty');
  const addBtn = document.getElementById('add');
  const saveBtn = document.getElementById('save');
  const resetBtn = document.getElementById('reset');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');

  /** @type {Array<{id: string, name: string, template: string, cleaning: string}>} */
  let types = [];
  const deleteTimers = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(message) {
    statusEl.textContent = message || '';
    if (message) errorEl.textContent = '';
  }

  function setError(message) {
    errorEl.textContent = message || '';
    if (message) statusEl.textContent = '';
  }

  function clearDeleteTimer(id) {
    const timer = deleteTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      deleteTimers.delete(id);
    }
  }

  function clearDeleteTimers() {
    for (const timer of deleteTimers.values()) clearTimeout(timer);
    deleteTimers.clear();
  }

  function rowError(row, message) {
    if (!row) return;
    const error = row.querySelector('.row-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
    for (const field of row.querySelectorAll('input, select')) {
      if (message) field.setAttribute('aria-invalid', 'true');
      else field.removeAttribute('aria-invalid');
    }
  }

  function clearRowErrors() {
    for (const row of rowsEl.children) rowError(row, '');
  }

  function updatePlaceholderNote(item, note) {
    const isExample = Boolean(item.template.trim()) && Links.isPlaceholderTemplate(item.template);
    note.hidden = !isExample;
  }

  function markDirty() {
    statusEl.textContent = '';
  }

  function createRow(item, index) {
    const row = el('div', 'type-row');
    row.dataset.id = item.id;

    row.appendChild(el('span', 'index', String(index + 1)));

    const nameField = el('div', 'field name');
    const nameLabel = el('label', 'sr-only', 'Name');
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.maxLength = Links.NAME_MAX;
    nameInput.value = item.name;
    nameInput.placeholder = 'Parcel ID';
    nameInput.setAttribute('aria-label', `Type ${index + 1} name`);
    nameInput.id = `name-${item.id}`;
    nameLabel.htmlFor = nameInput.id;
    nameField.append(nameLabel, nameInput);

    const templateField = el('div', 'field template');
    const templateInput = el('input');
    templateInput.type = 'text';
    templateInput.maxLength = Links.TEMPLATE_MAX;
    templateInput.value = item.template;
    templateInput.placeholder = 'https://example.com/parcel/{value}';
    templateInput.spellcheck = false;
    templateInput.setAttribute('aria-label', `Type ${index + 1} link template`);
    const placeholderNote = el('p', 'placeholder-note');
    placeholderNote.hidden = true;
    templateField.append(templateInput, placeholderNote);
    updatePlaceholderNote(item, placeholderNote);

    const cleaningField = el('div', 'field cleaning');
    const select = el('select');
    select.setAttribute('aria-label', `Type ${index + 1} cleaning mode`);
    for (const mode of Links.CLEANING_MODES) {
      const option = el('option', null, mode === 'Raw' ? 'Raw text' : mode);
      option.value = mode;
      select.appendChild(option);
    }
    select.value = item.cleaning;
    cleaningField.appendChild(select);

    const actions = el('div', 'row-actions');
    const testBtn = el('button', 'button small', 'Test');
    testBtn.type = 'button';
    const upBtn = el('button', 'button small move', '↑');
    upBtn.type = 'button';
    upBtn.title = 'Move up';
    upBtn.setAttribute('aria-label', `Move ${item.name || 'type'} up`);
    upBtn.disabled = index === 0;
    const downBtn = el('button', 'button small move', '↓');
    downBtn.type = 'button';
    downBtn.title = 'Move down';
    downBtn.setAttribute('aria-label', `Move ${item.name || 'type'} down`);
    downBtn.disabled = index === types.length - 1;
    const deleteBtn = el('button', 'button small danger-quiet', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('aria-label', `Delete ${item.name || 'type'}`);
    actions.append(testBtn, upBtn, downBtn, deleteBtn);

    const error = el('p', 'row-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');

    nameInput.addEventListener('input', () => {
      item.name = nameInput.value;
      rowError(row, '');
      markDirty();
    });
    templateInput.addEventListener('input', () => {
      item.template = templateInput.value;
      updatePlaceholderNote(item, placeholderNote);
      rowError(row, '');
      markDirty();
    });
    select.addEventListener('change', () => {
      item.cleaning = select.value;
      rowError(row, '');
      markDirty();
    });
    testBtn.addEventListener('click', () => testRow(item, row));
    upBtn.addEventListener('click', () => moveType(item.id, -1));
    downBtn.addEventListener('click', () => moveType(item.id, 1));
    deleteBtn.addEventListener('click', () => requestDelete(item.id, deleteBtn));

    row.append(nameField, templateField, cleaningField, actions, error);
    return row;
  }

  function render() {
    clearDeleteTimers();
    rowsEl.replaceChildren();
    types.forEach((item, index) => rowsEl.appendChild(createRow(item, index)));
    emptyEl.hidden = types.length > 0;
    addBtn.disabled = types.length >= Links.TYPES_MAX;
  }

  function focusRow(id) {
    const row = rowsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const input = row.querySelector('.field.name input');
    if (input) input.focus();
  }

  function markAllDirty() {
    statusEl.textContent = '';
  }

  function addType() {
    if (types.length >= Links.TYPES_MAX) {
      setError(`At most ${Links.TYPES_MAX} types are supported.`);
      return;
    }
    const item = Links.createType();
    types.push(item);
    markAllDirty();
    render();
    focusRow(item.id);
  }

  function moveType(id, delta) {
    const index = types.findIndex((t) => t.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= types.length) return;
    const [item] = types.splice(index, 1);
    types.splice(target, 0, item);
    markAllDirty();
    render();
    const row = rowsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) row.querySelector('.button.move')?.focus();
  }

  function requestDelete(id, button) {
    const existing = deleteTimers.get(id);
    if (!existing) {
      const item = types.find((t) => t.id === id);
      button.textContent = 'Confirm';
      button.classList.add('confirm');
      const timer = setTimeout(() => {
        deleteTimers.delete(id);
        const row = rowsEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
        const current = row && row.querySelector('.danger-quiet');
        if (current) {
          current.textContent = 'Delete';
          current.classList.remove('confirm');
        }
        if (item) button.setAttribute('aria-label', `Delete ${item.name || 'type'}`);
      }, 4000);
      deleteTimers.set(id, timer);
      return;
    }

    clearDeleteTimer(id);
    types = types.filter((t) => t.id !== id);
    markAllDirty();
    render();
  }

  function validateRow(item, index) {
    const row = rowsEl.children[index];
    rowError(row, '');

    const nameResult = Links.validateName(item.name, types, item.id);
    if (!nameResult.ok) {
      rowError(row, nameResult.error);
      return false;
    }
    const templateResult = Links.validateTemplate(item.template);
    if (!templateResult.ok) {
      rowError(row, templateResult.error);
      return false;
    }
    if (!Links.CLEANING_MODES.includes(item.cleaning)) {
      rowError(row, 'Choose a cleaning mode.');
      return false;
    }
    return true;
  }

  function validateAll() {
    clearRowErrors();
    let firstInvalid = null;
    types.forEach((item, index) => {
      if (!validateRow(item, index) && firstInvalid === null) firstInvalid = index;
    });
    if (firstInvalid !== null) {
      setError('Fix the highlighted fields before saving.');
      const row = rowsEl.children[firstInvalid];
      const input = row && row.querySelector('input');
      if (input) input.focus();
      return false;
    }
    try {
      Links.validateTypes(types);
    } catch (err) {
      setError(err.message);
      return false;
    }
    return true;
  }

  async function persist(messagePrefix) {
    try {
      const saved = await Links.saveTypes(types);
      types = saved.types;
      render();
      const area = saved.area === 'local' ? ' locally' : '';
      setStatus(`${messagePrefix} Saved${area}.`);
      await pruneLastType();
      return true;
    } catch (err) {
      setError(`Could not save: ${err.message}`);
      return false;
    }
  }

  async function pruneLastType() {
    try {
      const last = await Links.loadLastTypeId();
      if (last && !types.some((t) => t.id === last) && types.length) {
        await Links.saveLastTypeId(types[0].id);
      }
    } catch {
      // Best-effort only.
    }
  }

  async function save() {
    if (!validateAll()) return;
    await persist('Types saved.');
  }

  function testRow(item, row) {
    const nameResult = Links.validateName(item.name, types, item.id);
    if (!nameResult.ok) {
      rowError(row, nameResult.error);
      return;
    }
    const templateResult = Links.validateTemplate(item.template);
    if (!templateResult.ok) {
      rowError(row, templateResult.error);
      return;
    }
    const cleaned = Links.cleanValue('TEST123', item.cleaning);
    const url = Links.buildUrl(templateResult.value, cleaned.value);
    if (!url) {
      rowError(row, 'Could not build a test URL from this template.');
      return;
    }
    rowError(row, '');
    try {
      chrome.tabs.create({ url, active: true }, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          rowError(row, `Could not open the test link: ${lastError.message}`);
        } else {
          setStatus(`Opened test link for “${item.name}”.`);
        }
      });
    } catch (err) {
      rowError(row, `Could not open the test link: ${err.message}`);
    }
  }

  async function resetToDefaults() {
    const ok = window.confirm(
      'Replace all current types with the three example defaults? This also clears unsaved edits.',
    );
    if (!ok) return;
    types = Links.getDefaultTypes();
    render();
    if (await persist('Defaults restored.')) pruneLastType();
  }

  addBtn.addEventListener('click', addType);
  saveBtn.addEventListener('click', () => void save());
  resetBtn.addEventListener('click', () => void resetToDefaults());
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  });

  (async () => {
    try {
      types = await Links.loadTypes();
      render();
    } catch (err) {
      setError(`Could not load types: ${err.message}`);
      types = Links.getDefaultTypes();
      render();
    }
  })();
})();
