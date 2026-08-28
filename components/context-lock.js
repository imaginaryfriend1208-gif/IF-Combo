/**
 * Context Lock Manager
 * Adds a "Locked Context Size" control below the Context Size slider
 * in the Chat Completion parameters, and enforces the locked value.
 */

import { t } from '../../../../i18n.js';

const PRESET_SIZES = [100000, 150000, 180000, 200000];
const CUSTOM_VALUE = 'custom';

export class ContextLockManager {
    /**
     * @param {object} options
     * @param {() => object} options.getSettings - returns the contextLock settings object { enabled, size, customSize }
     * @param {() => void} options.saveSettings - persists settings
     */
    constructor({ getSettings, saveSettings }) {
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;

        this.visible = true;
        this.intervalId = null;
        this.applying = false;

        this.init();
    }

    init() {
        // Keep trying to inject the UI (the panel exists in static HTML, but be defensive)
        setTimeout(() => this.ensureUI(), 300);
        this.intervalId = setInterval(() => {
            this.ensureUI();
            this.enforceLock();
        }, 2000);

        // Re-enforce when the slider/counter value changes (model switch, preset load, manual edit)
        document.addEventListener('input', (e) => {
            if (!e.target) return;
            if (e.target.id === 'openai_max_context' || e.target.id === 'openai_max_context_counter') {
                this.enforceLock();
            }
        }, true);

        // Re-enforce after preset changes
        try {
            const context = SillyTavern.getContext();
            const { eventSource, eventTypes } = context;
            if (eventSource && eventTypes?.OAI_PRESET_CHANGED_AFTER) {
                eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, () => {
                    setTimeout(() => this.enforceLock(), 100);
                });
            }
            if (eventSource && eventTypes?.CHATCOMPLETION_MODEL_CHANGED) {
                eventSource.on(eventTypes.CHATCOMPLETION_MODEL_CHANGED, () => {
                    setTimeout(() => this.enforceLock(), 100);
                });
            }
        } catch {
            // Context not ready; interval fallback still applies
        }
    }

    setVisible(visible) {
        this.visible = visible;
        const block = document.getElementById('cct-context-lock-block');
        if (!visible) {
            if (block) block.remove();
            this.updateSliderLockedState(false);
        } else {
            this.ensureUI();
            this.enforceLock();
        }
    }

    getLockValue() {
        const settings = this.getSettings();
        if (settings.size === CUSTOM_VALUE) {
            const custom = Number(settings.customSize);
            return Number.isFinite(custom) && custom >= 512 ? Math.floor(custom) : null;
        }
        const size = Number(settings.size);
        return Number.isFinite(size) && size >= 512 ? size : null;
    }

    ensureUI() {
        if (!this.visible) return;
        if (document.getElementById('cct-context-lock-block')) return;

        const slider = document.getElementById('openai_max_context');
        if (!slider) return;

        const rangeBlock = slider.closest('.range-block');
        if (!rangeBlock) return;

        const settings = this.getSettings();

        const block = document.createElement('div');
        block.id = 'cct-context-lock-block';
        block.classList.add('range-block');

        const label = document.createElement('label');
        label.classList.add('checkbox_label', 'cct-context-lock-label');

        const checkbox = document.createElement('input');
        checkbox.id = 'cct-context-lock-enabled';
        checkbox.type = 'checkbox';
        checkbox.checked = !!settings.enabled;

        const labelText = document.createElement('span');
        labelText.innerHTML = '<i class="fa-solid fa-lock fa-xs"></i> ';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = t`Lock Context Size`;
        labelText.append(labelSpan);

        label.append(checkbox, labelText);

        const select = document.createElement('select');
        select.id = 'cct-context-lock-size';
        select.classList.add('text_pole', 'cct-context-lock-select');
        for (const size of PRESET_SIZES) {
            const option = document.createElement('option');
            option.value = String(size);
            option.textContent = `${size / 1000}k`;
            select.append(option);
        }
        const customOption = document.createElement('option');
        customOption.value = CUSTOM_VALUE;
        customOption.textContent = t`Custom`;
        select.append(customOption);
        select.value = String(settings.size);
        if (select.selectedIndex === -1) {
            select.value = String(PRESET_SIZES[0]);
        }

        const customInput = document.createElement('input');
        customInput.id = 'cct-context-lock-custom';
        customInput.type = 'number';
        customInput.classList.add('text_pole', 'cct-context-lock-custom');
        customInput.min = '512';
        customInput.step = '1';
        customInput.placeholder = t`tokens`;
        customInput.value = String(settings.customSize ?? 120000);
        customInput.style.display = settings.size === CUSTOM_VALUE ? '' : 'none';

        const row = document.createElement('div');
        row.classList.add('cct-context-lock-row');
        row.append(label, select, customInput);
        block.append(row);

        rangeBlock.insertAdjacentElement('afterend', block);

        // Events
        checkbox.addEventListener('change', () => {
            this.getSettings().enabled = checkbox.checked;
            this.saveSettings();
            this.updateSliderLockedState(checkbox.checked);
            this.enforceLock();
        });

        select.addEventListener('change', () => {
            const value = select.value === CUSTOM_VALUE ? CUSTOM_VALUE : Number(select.value);
            this.getSettings().size = value;
            customInput.style.display = value === CUSTOM_VALUE ? '' : 'none';
            this.saveSettings();
            this.enforceLock();
        });

        customInput.addEventListener('change', () => {
            this.getSettings().customSize = Number(customInput.value);
            this.saveSettings();
            this.enforceLock();
        });

        this.updateSliderLockedState(!!settings.enabled);
    }

    updateSliderLockedState(locked) {
        const slider = document.getElementById('openai_max_context');
        const counter = document.getElementById('openai_max_context_counter');
        for (const el of [slider, counter]) {
            if (!el) continue;
            el.classList.toggle('cct-locked-input', locked);
            el.disabled = locked;
        }
    }

    enforceLock() {
        if (!this.visible) return;
        if (this.applying) return;

        const settings = this.getSettings();
        if (!settings.enabled) return;

        const lockValue = this.getLockValue();
        if (!lockValue) return;

        const slider = document.getElementById('openai_max_context');
        if (!slider) return;

        const current = Number(slider.value);
        const max = Number(slider.getAttribute('max'));

        if (current === lockValue && max >= lockValue) {
            this.updateSliderLockedState(true);
            return;
        }

        this.applying = true;
        try {
            if (!Number.isFinite(max) || max < lockValue) {
                slider.setAttribute('max', String(lockValue));
            }
            const counter = document.getElementById('openai_max_context_counter');
            if (counter && Number(counter.getAttribute('max')) < lockValue) {
                counter.setAttribute('max', String(lockValue));
            }

            // Trigger ST's own input handler so oai_settings gets updated and saved.
            // ST binds via jQuery; a native event bubbles into jQuery listeners too.
            slider.value = String(lockValue);
            slider.dispatchEvent(new Event('input', { bubbles: true }));

            this.updateSliderLockedState(true);
        } finally {
            this.applying = false;
        }
    }

    destroy() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        const block = document.getElementById('cct-context-lock-block');
        if (block) block.remove();
        this.updateSliderLockedState(false);
    }
}
