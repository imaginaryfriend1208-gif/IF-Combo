/**
 * Preset Picker
 * Replaces the native Chat Completion preset dropdown with a custom
 * dropdown whose rows carry an inline delete button. The native select is
 * hidden (not removed): picking a row sets its value and fires "change" so
 * ST's own preset-switch handler does the work, and deletion goes through
 * ST's preset manager.
 */

import { t } from '../../../../i18n.js';

const SELECT_ID = 'settings_preset_openai';
const ROOT_ID = 'cct-preset-picker';
const GUI_PRESET_VALUE = 'gui';
const SELECT_EVENT_NS = '.cctPresetPicker';

export class PresetPickerManager {
    constructor() {
        this.enabled = true;
        this.intervalId = null;
        this.isOpen = false;
        this.root = null;
        this.toggle = null;
        this.toggleLabel = null;
        this.menu = null;
        this.select = null;
        this.eventBindings = [];

        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.handleDocumentKeydown = this.handleDocumentKeydown.bind(this);
        this.refreshLabel = this.refreshLabel.bind(this);

        this.init();
    }

    init() {
        document.addEventListener('click', this.handleDocumentClick, true);
        document.addEventListener('keydown', this.handleDocumentKeydown);
        this.bindSillyTavernEvents();

        setTimeout(() => this.apply(), 500);
        this.intervalId = setInterval(() => {
            if (!this.enabled) return;
            if (!document.getElementById(ROOT_ID)) {
                this.apply();
            } else {
                this.refreshLabel();
            }
        }, 2000);
    }

    bindSillyTavernEvents() {
        try {
            const { eventSource, eventTypes } = SillyTavern.getContext();
            if (!eventSource || !eventTypes) return;

            const eventNames = [
                'SETTINGS_LOADED_AFTER',
                'OAI_PRESET_CHANGED_AFTER',
                'PRESET_DELETED',
                'PRESET_RENAMED',
            ];

            for (const eventName of eventNames) {
                const eventType = eventTypes[eventName];
                if (!eventType) continue;
                eventSource.on(eventType, this.refreshLabel);
                this.eventBindings.push({ eventSource, eventType });
            }
        } catch {
            // The polling interval still keeps the label in sync.
        }
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.teardown();
        } else {
            this.apply();
        }
    }

    apply() {
        if (!this.enabled) return;
        if (document.getElementById(ROOT_ID)) return;

        const select = document.getElementById(SELECT_ID);
        if (!select) return;
        this.select = select;

        // Hide the native select, keep it functional for reuse
        select.classList.add('cct-prompt-picker-hidden');
        this.bindSelectChange(select, true);

        this.root = document.createElement('div');
        this.root.id = ROOT_ID;
        this.root.classList.add('cct-prompt-picker', 'cct-preset-picker');

        this.toggle = document.createElement('button');
        this.toggle.type = 'button';
        this.toggle.classList.add('text_pole', 'cct-prompt-picker-toggle');
        this.toggle.setAttribute('aria-haspopup', 'menu');
        this.toggle.setAttribute('aria-expanded', 'false');

        this.toggleLabel = document.createElement('span');
        this.toggleLabel.classList.add('cct-prompt-picker-toggle-label');

        const toggleCaret = document.createElement('i');
        toggleCaret.classList.add('fa-solid', 'fa-caret-down');

        this.toggle.append(this.toggleLabel, toggleCaret);
        this.toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleMenu();
        });

        this.menu = document.createElement('div');
        this.menu.classList.add('cct-prompt-picker-menu');
        this.menu.setAttribute('role', 'menu');
        this.menu.hidden = true;

        this.root.append(this.toggle, this.menu);
        select.insertAdjacentElement('afterend', this.root);

        this.refreshLabel();
    }

    /**
     * ST switches presets with jQuery's trigger('change'), which does not
     * reach native listeners, so bind through jQuery when it is available.
     */
    bindSelectChange(select, on) {
        const jq = window.jQuery;
        if (jq) {
            jq(select).off(SELECT_EVENT_NS);
            if (on) jq(select).on(`change${SELECT_EVENT_NS}`, this.refreshLabel);
            return;
        }
        select.removeEventListener('change', this.refreshLabel);
        if (on) select.addEventListener('change', this.refreshLabel);
    }

    refreshLabel() {
        if (!this.toggleLabel || !this.select) return;
        const selected = this.select.selectedOptions[0];
        const text = selected?.textContent?.trim() || t`Select a preset`;
        this.toggleLabel.textContent = text;
        this.toggle.title = text;
        if (this.isOpen) this.renderMenu();
    }

    toggleMenu() {
        if (this.isOpen) {
            this.closeMenu();
        } else {
            this.openMenu();
        }
    }

    openMenu() {
        if (!this.menu) return;
        this.renderMenu();
        this.isOpen = true;
        this.menu.hidden = false;
        this.toggle?.setAttribute('aria-expanded', 'true');
        this.menu.querySelector('.cct-active')?.scrollIntoView({ block: 'nearest' });
    }

    closeMenu() {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (this.menu) this.menu.hidden = true;
        this.toggle?.setAttribute('aria-expanded', 'false');
    }

    renderMenu() {
        if (!this.menu || !this.select) return;
        this.menu.replaceChildren();

        const options = [...this.select.options];
        if (!options.length) {
            const empty = document.createElement('div');
            empty.classList.add('cct-prompt-picker-empty');
            empty.textContent = t`No presets`;
            this.menu.append(empty);
            return;
        }

        for (const option of options) {
            const presetName = option.textContent;
            const isActive = option.value === this.select.value;

            const row = document.createElement('div');
            row.classList.add('cct-prompt-picker-item', 'cct-preset-picker-item');
            row.classList.toggle('cct-active', isActive);
            row.setAttribute('role', 'menuitemradio');
            row.setAttribute('aria-checked', String(isActive));
            row.tabIndex = 0;
            row.addEventListener('click', () => this.selectPreset(option.value));
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.selectPreset(option.value);
                }
            });

            const name = document.createElement('span');
            name.classList.add('cct-prompt-picker-item-name');
            name.textContent = presetName;
            name.title = presetName;

            const actions = document.createElement('div');
            actions.classList.add('cct-prompt-picker-item-actions');

            if (isActive) {
                const activeMark = document.createElement('i');
                activeMark.classList.add('fa-solid', 'fa-check', 'cct-prompt-picker-linked-mark');
                activeMark.title = t`Current preset`;
                actions.append(activeMark);
            }

            // The placeholder "Default" option shown before settings load
            // cannot be deleted.
            if (option.value !== GUI_PRESET_VALUE) {
                const deleteAction = document.createElement('button');
                deleteAction.type = 'button';
                deleteAction.classList.add('cct-prompt-picker-action', 'cct-prompt-picker-delete');
                deleteAction.title = t`Delete preset`;
                deleteAction.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
                deleteAction.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.deletePreset(presetName, isActive);
                });
                deleteAction.addEventListener('keydown', (event) => event.stopPropagation());
                actions.append(deleteAction);
            }

            row.append(name, actions);
            this.menu.append(row);
        }
    }

    /**
     * Switches presets through the hidden native select so ST's own change
     * handler loads the preset.
     */
    selectPreset(value) {
        this.closeMenu();
        if (!this.select || this.select.value === value) return;
        this.select.value = value;
        this.select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async deletePreset(presetName, isActive) {
        this.closeMenu();

        const context = SillyTavern.getContext();
        const presetManager = context.getPresetManager?.('openai');
        if (!presetManager) return;

        const confirmed = await this.confirmPopup(
            `${t`Delete preset`}: ${presetName}?`,
            t`This action is irreversible.`,
        );
        if (!confirmed) return;

        // The active preset is deleted without a name so ST switches to the
        // next preset (its by-name path removes the option before checking
        // whether it was selected, so it would never switch). Other presets
        // are deleted by name, leaving the active one loaded.
        const result = isActive
            ? await presetManager.deletePreset()
            : await presetManager.deletePreset(presetName);
        if (result === undefined) return; // ST already showed why it refused

        if (result) {
            toastr.success(t`Preset deleted`);
            const { eventSource, eventTypes } = context;
            if (eventSource && eventTypes?.PRESET_DELETED) {
                await eventSource.emit(eventTypes.PRESET_DELETED, { apiId: 'openai', name: presetName });
            }
        } else {
            toastr.warning(t`Preset was not deleted from server`);
        }

        context.saveSettingsDebounced();
        this.refreshLabel();
    }

    async confirmPopup(header, text) {
        const context = SillyTavern.getContext();
        try {
            if (context.Popup?.show?.confirm) {
                return await context.Popup.show.confirm(header, text);
            }
        } catch {
            // Fall through to the browser dialog
        }
        return window.confirm(`${header}\n${text}`);
    }

    handleDocumentClick(event) {
        if (this.isOpen && this.root && !this.root.contains(event.target)) {
            this.closeMenu();
        }
    }

    handleDocumentKeydown(event) {
        if (event.key === 'Escape' && this.isOpen) {
            this.closeMenu();
            this.toggle?.focus();
        }
    }

    teardown() {
        this.closeMenu();
        const select = this.select ?? document.getElementById(SELECT_ID);
        if (select) {
            select.classList.remove('cct-prompt-picker-hidden');
            this.bindSelectChange(select, false);
        }
        document.getElementById(ROOT_ID)?.remove();
        this.root = null;
        this.toggle = null;
        this.toggleLabel = null;
        this.menu = null;
        this.select = null;
    }

    destroy() {
        this.enabled = false;
        if (this.intervalId) clearInterval(this.intervalId);
        for (const { eventSource, eventType } of this.eventBindings) {
            eventSource.removeListener?.(eventType, this.refreshLabel);
        }
        this.eventBindings = [];
        document.removeEventListener('click', this.handleDocumentClick, true);
        document.removeEventListener('keydown', this.handleDocumentKeydown);
        this.teardown();
    }
}
