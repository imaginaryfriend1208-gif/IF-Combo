/**
 * Prompt Combos
 * Lets the user save the current on/off state of the prompts in the Chat
 * Completion prompt manager as a named "combo" and re-apply it later with
 * one click.
 *
 * Combos are stored inside the preset file itself (the preset's
 * `extensions.ifCombo.promptCombos` field, saved by ST to the user's
 * data folder), so they survive reloads, follow preset renames and are
 * included when the preset is exported. Combos saved by older versions in
 * the extension settings are moved into the preset the first time it is
 * opened.
 *
 * Applying a combo only flips the enabled flag of the prompt order entries
 * (the same thing the native toggle button does); it never changes the
 * prompt order or the prompt contents.
 */

import { t } from '../../../../i18n.js';
import { oai_settings, promptManager } from './../../../../openai.js';

const CONTAINER_SELECTOR = '#completion_prompt_manager';
const FOOTER_SELECTOR = '.completion_prompt_manager_footer';
const BUTTON_ID = 'cct-prompt-combos';
const MENU_CLASS = 'cct-prompt-combos-menu';
const PRESET_FIELD_PATH = 'ifCombo.promptCombos';

export class PromptComboManager {
    /**
     * @param {object} options
     * @param {() => object} options.getSettings - returns the legacy promptCombos settings object { presets }
     * @param {() => void} options.saveSettings - persists extension settings
     */
    constructor({ getSettings, saveSettings }) {
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;

        this.enabled = true;
        this.migrating = new Set();
        this.migrationFailed = new Set(); // preset names not retried this session
        this.observer = null;
        this.intervalId = null;
        this.mutating = false;
        this.menu = null;

        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.handleDocumentKeydown = this.handleDocumentKeydown.bind(this);

        this.init();
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    init() {
        document.addEventListener('click', this.handleDocumentClick, true);
        document.addEventListener('keydown', this.handleDocumentKeydown);

        setTimeout(() => this.apply(), 500);
        this.intervalId = setInterval(() => {
            if (!this.enabled) return;
            this.apply();
        }, 2000);

        const attachObserver = () => {
            const container = document.querySelector(CONTAINER_SELECTOR);
            if (!container) return false;
            this.observer = new MutationObserver(() => {
                if (this.mutating) return;
                this.apply();
            });
            this.observer.observe(container, { childList: true, subtree: true });
            return true;
        };

        if (!attachObserver()) {
            const retry = setInterval(() => {
                if (attachObserver()) clearInterval(retry);
            }, 1000);
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

    endMutation() {
        setTimeout(() => { this.mutating = false; }, 0);
    }

    /* ------------------------------------------------------------------ */
    /* Settings helpers                                                    */
    /* ------------------------------------------------------------------ */

    getPresetManager() {
        try {
            return SillyTavern.getContext().getPresetManager?.('openai') ?? null;
        } catch {
            return null;
        }
    }

    getPresetName() {
        return this.getPresetManager()?.getSelectedPresetName?.()
            || oai_settings?.preset_settings_openai
            || 'Default';
    }

    /** Combos saved by older versions in the extension settings, keyed by preset name. */
    getLegacyCombos(name) {
        const combos = this.getSettings()?.presets?.[name];
        return Array.isArray(combos) ? combos : null;
    }

    /**
     * Returns a copy of the current preset's combos. Callers modify the copy
     * and pass it to saveCombos().
     * @returns {Array<{id: string, name: string, enabled: string[]}>}
     */
    getCombos() {
        const name = this.getPresetName();
        const presetManager = this.getPresetManager();

        // Very old ST without preset extension fields: keep the legacy store
        if (!presetManager?.readPresetExtensionField) {
            return structuredClone(this.getLegacyCombos(name) ?? []);
        }

        const stored = presetManager.readPresetExtensionField({ name, path: PRESET_FIELD_PATH });
        if (Array.isArray(stored)) return structuredClone(stored);

        const legacy = this.getLegacyCombos(name);
        if (legacy?.length) {
            this.migrateLegacy(name, legacy);
            return structuredClone(legacy);
        }
        return [];
    }

    /**
     * Writes the combos into the current preset file through ST's preset
     * manager. ST also mirrors the value into the loaded settings.
     */
    async saveCombos(combos) {
        const name = this.getPresetName();
        const presetManager = this.getPresetManager();

        if (!presetManager?.writePresetExtensionField) {
            const settings = this.getSettings();
            if (!settings.presets) settings.presets = {};
            settings.presets[name] = combos;
            this.saveSettings();
            return true;
        }

        try {
            await presetManager.writePresetExtensionField({ name, path: PRESET_FIELD_PATH, value: combos });
            this.removeLegacy(name);
            return true;
        } catch (error) {
            // ST already shows a "Preset could not be saved" toast
            console.error('[IF Combo] Could not save prompt combos to the preset', error);
            return false;
        }
    }

    /** Moves combos from the extension settings into the preset file once. */
    async migrateLegacy(name, legacy) {
        if (this.migrating.has(name) || this.migrationFailed.has(name)) return;
        this.migrating.add(name);
        try {
            const presetManager = this.getPresetManager();
            await presetManager.writePresetExtensionField({ name, path: PRESET_FIELD_PATH, value: structuredClone(legacy) });
            this.removeLegacy(name);
        } catch (error) {
            // Keep the legacy copy so nothing is lost; try again next session
            this.migrationFailed.add(name);
            console.error('[IF Combo] Could not move prompt combos into the preset', error);
        } finally {
            this.migrating.delete(name);
        }
    }

    removeLegacy(name) {
        const settings = this.getSettings();
        if (settings?.presets && name in settings.presets) {
            delete settings.presets[name];
            this.saveSettings();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Prompt manager access                                               */
    /* ------------------------------------------------------------------ */

    getPromptOrder() {
        try {
            if (!promptManager?.activeCharacter) return null;
            return promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
        } catch {
            return null;
        }
    }

    /** Identifiers of the prompts currently toggled on, in order. */
    captureEnabled() {
        const order = this.getPromptOrder();
        if (!order) return null;
        return order.filter(entry => entry.enabled).map(entry => entry.identifier);
    }

    isComboActive(combo) {
        const current = this.captureEnabled();
        if (!current) return false;
        if (current.length !== combo.enabled.length) return false;
        const set = new Set(combo.enabled);
        return current.every(id => set.has(id));
    }

    applyCombo(combo) {
        const order = this.getPromptOrder();
        if (!order) return;

        const wanted = new Set(combo.enabled);
        const counts = promptManager.tokenHandler?.getCounts?.();

        for (const entry of order) {
            const next = wanted.has(entry.identifier);
            if (entry.enabled !== next) {
                entry.enabled = next;
                if (counts) counts[entry.identifier] = null;
            }
        }

        // Same calls the native toggle button makes
        promptManager.render();
        promptManager.saveServiceSettings();
    }

    /* ------------------------------------------------------------------ */
    /* Footer button                                                       */
    /* ------------------------------------------------------------------ */

    apply() {
        if (!this.enabled) return;

        const container = document.querySelector(CONTAINER_SELECTOR);
        const footer = container?.querySelector(FOOTER_SELECTOR);
        if (!footer) return;

        let button = document.getElementById(BUTTON_ID);
        if (!button) {
            this.mutating = true;
            try {
                button = document.createElement('a');
                button.id = BUTTON_ID;
                button.classList.add('menu_button', 'fa-solid', 'fa-fw', 'fa-bookmark');
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.toggleMenu(button);
                });

                // Right after the hide-disabled button if present, else after export
                const anchor = footer.querySelector('#cct-hide-disabled-prompts')
                    ?? footer.querySelector('#prompt-manager-export')
                    ?? footer.querySelector('#prompt-manager-import');
                if (anchor) {
                    anchor.insertAdjacentElement('afterend', button);
                } else {
                    footer.append(button);
                }
            } finally {
                this.endMutation();
            }
        }

        const combos = this.getCombos();
        const active = combos.find(c => this.isComboActive(c));
        button.classList.toggle('cct-active', !!active);
        button.title = active
            ? `${t`Prompt combos`}: ${active.name}`
            : `${t`Prompt combos`} (${combos.length})`;
    }

    /* ------------------------------------------------------------------ */
    /* Menu                                                                */
    /* ------------------------------------------------------------------ */

    toggleMenu(anchor) {
        if (this.menu) {
            this.closeMenu();
        } else {
            this.openMenu(anchor);
        }
    }

    openMenu(anchor) {
        this.closeMenu();

        const menu = document.createElement('div');
        menu.classList.add(MENU_CLASS);
        menu.setAttribute('role', 'menu');

        const combos = this.getCombos();

        if (!combos.length) {
            const empty = document.createElement('div');
            empty.classList.add('cct-prompt-combos-empty');
            empty.textContent = t`No saved combos`;
            menu.append(empty);
        }

        for (const combo of combos) {
            menu.append(this.buildComboRow(combo));
        }

        const divider = document.createElement('div');
        divider.classList.add('cct-prompt-combos-divider');
        menu.append(divider);

        const saveRow = document.createElement('div');
        saveRow.classList.add('cct-prompt-combos-item', 'cct-prompt-combos-save');
        saveRow.setAttribute('role', 'menuitem');
        saveRow.innerHTML = '<i class="fa-solid fa-plus fa-fw"></i>';
        const saveLabel = document.createElement('span');
        saveLabel.classList.add('cct-prompt-combos-item-name');
        saveLabel.textContent = t`Save current as combo`;
        saveRow.append(saveLabel);
        saveRow.addEventListener('click', (event) => {
            event.stopPropagation();
            this.closeMenu();
            this.createCombo();
        });
        menu.append(saveRow);

        document.body.append(menu);
        this.menu = menu;

        // Position below the button, kept inside the viewport
        const rect = anchor.getBoundingClientRect();
        const margin = 8;
        let left = rect.left;
        if (left + menu.offsetWidth > window.innerWidth - margin) {
            left = Math.max(margin, window.innerWidth - margin - menu.offsetWidth);
        }
        let top = rect.bottom + 4;
        if (top + menu.offsetHeight > window.innerHeight - margin) {
            top = Math.max(margin, rect.top - 4 - menu.offsetHeight);
        }
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    buildComboRow(combo) {
        const row = document.createElement('div');
        row.classList.add('cct-prompt-combos-item');
        row.setAttribute('role', 'menuitem');
        if (this.isComboActive(combo)) row.classList.add('cct-active');

        const icon = document.createElement('i');
        icon.classList.add('fa-solid', 'fa-fw', row.classList.contains('cct-active') ? 'fa-check' : 'fa-bookmark');

        const name = document.createElement('span');
        name.classList.add('cct-prompt-combos-item-name');
        name.textContent = combo.name;
        name.title = `${combo.name} (${combo.enabled.length})`;

        const count = document.createElement('span');
        count.classList.add('cct-prompt-combos-count');
        count.textContent = String(combo.enabled.length);

        const actions = document.createElement('span');
        actions.classList.add('cct-prompt-combos-actions');

        const makeAction = (iconClass, title, onClick, extraClass = null) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.classList.add('cct-prompt-combos-action');
            if (extraClass) btn.classList.add(extraClass);
            btn.title = title;
            btn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                onClick();
            });
            return btn;
        };

        actions.append(
            makeAction('fa-rotate', t`Update combo with current toggles`, () => {
                this.closeMenu();
                this.updateCombo(combo.id);
            }),
            makeAction('fa-pencil', t`Rename combo`, () => {
                this.closeMenu();
                this.renameCombo(combo.id);
            }),
            makeAction('fa-trash-can', t`Delete combo`, () => {
                this.closeMenu();
                this.deleteCombo(combo.id);
            }, 'cct-prompt-combos-delete'),
        );

        row.append(icon, name, count, actions);
        row.addEventListener('click', (event) => {
            event.stopPropagation();
            this.closeMenu();
            this.applyCombo(combo);
        });

        return row;
    }

    closeMenu() {
        if (this.menu) {
            this.menu.remove();
            this.menu = null;
        }
    }

    handleDocumentClick(event) {
        if (this.menu && !this.menu.contains(event.target)) {
            this.closeMenu();
        }
    }

    handleDocumentKeydown(event) {
        if (event.key === 'Escape' && this.menu) {
            this.closeMenu();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Combo operations                                                    */
    /* ------------------------------------------------------------------ */

    async createCombo() {
        const enabled = this.captureEnabled();
        if (!enabled) return;

        const name = await this.inputPopup(t`Combo name`);
        if (!name || !name.trim()) return;

        const combos = this.getCombos();
        combos.push({
            id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
            name: name.trim(),
            enabled,
        });
        await this.saveCombos(combos);
        this.apply();
    }

    async updateCombo(comboId) {
        const combos = this.getCombos();
        const combo = combos.find(c => c.id === comboId);
        const enabled = this.captureEnabled();
        if (!combo || !enabled) return;

        combo.enabled = enabled;
        await this.saveCombos(combos);
        this.apply();
    }

    async renameCombo(comboId) {
        const initial = this.getCombos().find(c => c.id === comboId);
        if (!initial) return;

        const name = await this.inputPopup(t`Combo name`, initial.name);
        if (!name || !name.trim()) return;

        // Re-read after the popup in case the preset changed meanwhile
        const combos = this.getCombos();
        const combo = combos.find(c => c.id === comboId);
        if (!combo) return;

        combo.name = name.trim();
        await this.saveCombos(combos);
        this.apply();
    }

    async deleteCombo(comboId) {
        const initial = this.getCombos().find(c => c.id === comboId);
        if (!initial) return;

        const ok = await this.confirmPopup(`${t`Delete combo`}: ${initial.name}?`);
        if (!ok) return;

        const combos = this.getCombos().filter(c => c.id !== comboId);
        await this.saveCombos(combos);
        this.apply();
    }

    /* ------------------------------------------------------------------ */
    /* Utilities                                                           */
    /* ------------------------------------------------------------------ */

    async inputPopup(title, defaultValue = '') {
        try {
            const context = SillyTavern.getContext();
            if (context.Popup?.show?.input) {
                return await context.Popup.show.input(title, null, defaultValue);
            }
        } catch {
            // Fall through to native prompt
        }
        return window.prompt(title, defaultValue);
    }

    async confirmPopup(text) {
        try {
            const context = SillyTavern.getContext();
            if (context.Popup?.show?.confirm) {
                return await context.Popup.show.confirm(text);
            }
        } catch {
            // Fall through to native confirm
        }
        return window.confirm(text);
    }

    teardown() {
        this.closeMenu();
        document.getElementById(BUTTON_ID)?.remove();
    }

    destroy() {
        this.enabled = false;
        if (this.intervalId) clearInterval(this.intervalId);
        if (this.observer) this.observer.disconnect();
        document.removeEventListener('click', this.handleDocumentClick, true);
        document.removeEventListener('keydown', this.handleDocumentKeydown);
        this.teardown();
    }
}
