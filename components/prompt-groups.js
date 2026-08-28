/**
 * Prompt Group Manager
 * Lets the user create named groups and assign prompts of the current
 * Chat Completion preset to them. Groups are rendered as collapsible
 * section headers inside the prompt manager list and are stored
 * per-preset in the extension settings.
 *
 * Grouping is purely visual: while group view is active, drag-sorting is
 * disabled so the real prompt (injection) order is never modified.
 */

import { t } from '../../../../i18n.js';
import { oai_settings } from './../../../../openai.js';

const LIST_SELECTOR = '#completion_prompt_manager_list';
const CONTAINER_SELECTOR = '#completion_prompt_manager';
const UNGROUPED_ID = '__ungrouped__';

export class PromptGroupManager {
    /**
     * @param {object} options
     * @param {() => object} options.getSettings - returns the promptGroups settings object { viewEnabled, presets }
     * @param {() => void} options.saveSettings - persists settings
     */
    constructor({ getSettings, saveSettings }) {
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;

        this.enabled = true;
        this.grouped = false;
        this.mutating = false;
        this.draggingId = null;
        this.originalOrder = [];
        this.observer = null;
        this.menuElement = null;

        this.init();
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    init() {
        setTimeout(() => this.apply(), 500);
        // Fallback: re-apply only when the grouped markup is missing
        this.intervalId = setInterval(() => {
            if (!this.enabled) return;
            this.ensureToolbar();
            if (!this.grouped) this.apply();
        }, 2000);

        const attachObserver = () => {
            const container = document.querySelector(CONTAINER_SELECTOR);
            if (!container) return false;
            this.observer = new MutationObserver(() => {
                if (this.mutating) return;
                // ST re-rendered the list; our markup is gone
                this.grouped = false;
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

        document.addEventListener('click', (e) => {
            if (this.menuElement && !this.menuElement.contains(e.target)) {
                this.closeMenu();
            }
        }, true);
    }

    /**
     * MutationObserver callbacks run as microtasks after our synchronous DOM
     * changes, so the flag must be cleared on a later macrotask — otherwise
     * the observer would see our own mutations and re-trigger apply().
     */
    endMutation() {
        setTimeout(() => { this.mutating = false; }, 0);
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.teardown();
            const toolbar = document.getElementById('cct-group-toolbar');
            if (toolbar) toolbar.remove();
        } else {
            this.apply();
        }
    }

    destroy() {
        if (this.intervalId) clearInterval(this.intervalId);
        if (this.observer) this.observer.disconnect();
        this.setEnabled(false);
    }

    /* ------------------------------------------------------------------ */
    /* Settings helpers                                                    */
    /* ------------------------------------------------------------------ */

    getPresetName() {
        return oai_settings?.preset_settings_openai || 'Default';
    }

    getPresetData() {
        const settings = this.getSettings();
        if (!settings.presets) settings.presets = {};
        const name = this.getPresetName();
        if (!settings.presets[name]) {
            settings.presets[name] = { groups: [], assignments: {} };
        }
        return settings.presets[name];
    }

    isViewEnabled() {
        return this.getSettings().viewEnabled !== false;
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                           */
    /* ------------------------------------------------------------------ */

    apply() {
        if (!this.enabled) return;

        const list = document.querySelector(LIST_SELECTOR);
        if (!list) return;

        this.ensureToolbar();

        if (!this.isViewEnabled()) {
            this.teardown();
            return;
        }

        const data = this.getPresetData();
        if (!data.groups.length) {
            this.teardown();
            return;
        }

        const prompts = [...list.querySelectorAll('li[data-pm-identifier]')];
        if (!prompts.length) return;

        // Remember ST's own (true) order before we shuffle the DOM
        if (!this.grouped) {
            this.originalOrder = prompts.map(li => li.dataset.pmIdentifier);
        }

        this.mutating = true;
        try {
            // Remove stale headers
            list.querySelectorAll('.cct-group-header').forEach(el => el.remove());

            const byId = new Map(prompts.map(li => [li.dataset.pmIdentifier, li]));
            const orderedIds = this.originalOrder.filter(id => byId.has(id));
            // Include any prompts that appeared after we captured the order
            for (const li of prompts) {
                if (!orderedIds.includes(li.dataset.pmIdentifier)) {
                    orderedIds.push(li.dataset.pmIdentifier);
                }
            }

            const sections = [...data.groups.map(g => ({ group: g, ids: [] })), { group: null, ids: [] }];
            const groupIndex = new Map(data.groups.map((g, i) => [g.id, i]));

            for (const id of orderedIds) {
                const gid = data.assignments[id];
                const idx = groupIndex.has(gid) ? groupIndex.get(gid) : sections.length - 1;
                sections[idx].ids.push(id);
            }

            for (const section of sections) {
                const isUngrouped = section.group === null;
                if (isUngrouped && !section.ids.length) continue;

                const header = this.buildGroupHeader(
                    isUngrouped ? { id: UNGROUPED_ID, name: t`Ungrouped`, collapsed: false } : section.group,
                    section.ids.length,
                    isUngrouped,
                );
                list.appendChild(header);

                const collapsed = !isUngrouped && !!section.group.collapsed;
                for (const id of section.ids) {
                    const li = byId.get(id);
                    li.classList.toggle('cct-group-hidden', collapsed);
                    this.ensureAssignButton(li);
                    this.bindPromptDnd(li);
                    list.appendChild(li);
                }
            }

            this.grouped = true;
            this.setSortableDisabled(true);
        } finally {
            this.endMutation();
        }
    }

    teardown() {
        const list = document.querySelector(LIST_SELECTOR);
        if (!list || !this.grouped) return;

        this.mutating = true;
        try {
            list.querySelectorAll('.cct-group-header').forEach(el => el.remove());

            const byId = new Map(
                [...list.querySelectorAll('li[data-pm-identifier]')]
                    .map(li => [li.dataset.pmIdentifier, li]),
            );
            for (const id of this.originalOrder) {
                const li = byId.get(id);
                if (li) {
                    li.classList.remove('cct-group-hidden');
                    li.draggable = false; // hand mouse-dragging back to jQuery sortable
                    list.appendChild(li);
                }
            }

            this.grouped = false;
            this.setSortableDisabled(false);
        } finally {
            this.endMutation();
        }
    }

    buildGroupHeader(group, count, isUngrouped) {
        const li = document.createElement('li');
        li.classList.add('cct-group-header');
        if (isUngrouped) li.classList.add('cct-group-header-ungrouped');
        li.dataset.cctGroupId = group.id;

        const caret = document.createElement('i');
        caret.classList.add('fa-solid', group.collapsed ? 'fa-caret-right' : 'fa-caret-down', 'cct-group-caret');

        const name = document.createElement('span');
        name.classList.add('cct-group-name');
        name.textContent = group.name;

        const countSpan = document.createElement('span');
        countSpan.classList.add('cct-group-count');
        countSpan.textContent = String(count);

        const left = document.createElement('span');
        left.classList.add('cct-group-header-left');
        left.append(caret, name, countSpan);
        li.append(left);

        left.addEventListener('click', () => this.toggleCollapse(group.id));

        // Allow dropping prompts onto the header to assign them to this group
        li.addEventListener('dragover', (e) => {
            if (!this.draggingId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            li.classList.add('cct-drop-target');
        });
        li.addEventListener('dragleave', () => li.classList.remove('cct-drop-target'));
        li.addEventListener('drop', (e) => {
            if (!this.draggingId) return;
            e.preventDefault();
            e.stopPropagation();
            li.classList.remove('cct-drop-target');
            const id = this.draggingId;
            this.draggingId = null;
            this.assignPrompt(id, isUngrouped ? null : group.id);
        });

        if (!isUngrouped) {
            const controls = document.createElement('span');
            controls.classList.add('cct-group-header-controls');

            const renameBtn = document.createElement('i');
            renameBtn.classList.add('fa-solid', 'fa-pencil', 'fa-xs');
            renameBtn.title = t`Rename group`;
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.renameGroup(group.id);
            });

            const deleteBtn = document.createElement('i');
            deleteBtn.classList.add('fa-solid', 'fa-trash-can', 'fa-xs', 'cct-group-delete');
            deleteBtn.title = t`Delete group`;
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteGroup(group.id);
            });

            controls.append(renameBtn, deleteBtn);
            li.append(controls);
        }

        return li;
    }

    /**
     * Native HTML5 drag & drop for assigning prompts to groups while the
     * group view is active (jQuery sortable is disabled in that state).
     * Dropping onto a group header — or onto another prompt — assigns the
     * dragged prompt to that group.
     */
    bindPromptDnd(li) {
        li.draggable = true; // re-set every apply(); teardown() clears it

        if (li.dataset.cctDndBound) return;
        li.dataset.cctDndBound = '1';

        li.addEventListener('dragstart', (e) => {
            if (!this.grouped) {
                e.preventDefault();
                return;
            }
            this.draggingId = li.dataset.pmIdentifier;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', this.draggingId);
            li.classList.add('cct-dragging');
        });

        li.addEventListener('dragend', () => {
            li.classList.remove('cct-dragging');
            this.draggingId = null;
            document.querySelectorAll('.cct-drop-target')
                .forEach(el => el.classList.remove('cct-drop-target'));
        });

        // Dropping onto another prompt assigns to that prompt's group
        li.addEventListener('dragover', (e) => {
            if (!this.draggingId || this.draggingId === li.dataset.pmIdentifier) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            li.classList.add('cct-drop-target');
        });
        li.addEventListener('dragleave', () => li.classList.remove('cct-drop-target'));
        li.addEventListener('drop', (e) => {
            if (!this.draggingId || this.draggingId === li.dataset.pmIdentifier) return;
            e.preventDefault();
            e.stopPropagation();
            li.classList.remove('cct-drop-target');
            const id = this.draggingId;
            this.draggingId = null;
            const targetGroup = this.getPresetData().assignments[li.dataset.pmIdentifier] ?? null;
            this.assignPrompt(id, targetGroup);
        });
    }

    ensureAssignButton(li) {
        const controls = li.querySelector('.prompt_manager_prompt_controls');
        if (!controls || controls.querySelector('.cct-assign-action')) return;

        const btn = document.createElement('span');
        btn.classList.add('cct-assign-action', 'fa-solid', 'fa-folder-plus', 'fa-xs');
        btn.title = t`Assign to group`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openAssignMenu(li.dataset.pmIdentifier, btn);
        });
        controls.prepend(btn);
    }

    ensureToolbar() {
        const list = document.querySelector(LIST_SELECTOR);
        if (!list || document.getElementById('cct-group-toolbar')) return;

        this.mutating = true;
        try {
            const toolbar = document.createElement('div');
            toolbar.id = 'cct-group-toolbar';
            toolbar.classList.add('flex-container', 'cct-group-toolbar');

            const toggleBtn = document.createElement('div');
            toggleBtn.classList.add('menu_button', 'menu_button_icon', 'cct-group-toggle');
            toggleBtn.classList.toggle('cct-active', this.isViewEnabled());
            toggleBtn.title = t`Toggle group view`;
            toggleBtn.innerHTML = '<i class="fa-solid fa-layer-group"></i><span>' + t`Groups` + '</span>';
            toggleBtn.addEventListener('click', () => {
                const settings = this.getSettings();
                settings.viewEnabled = !this.isViewEnabled();
                this.saveSettings();
                toggleBtn.classList.toggle('cct-active', settings.viewEnabled);
                if (settings.viewEnabled) {
                    this.apply();
                } else {
                    this.teardown();
                }
            });

            const addBtn = document.createElement('div');
            addBtn.classList.add('menu_button', 'menu_button_icon');
            addBtn.title = t`New group`;
            addBtn.innerHTML = '<i class="fa-solid fa-plus"></i><span>' + t`New group` + '</span>';
            addBtn.addEventListener('click', () => this.createGroup());

            toolbar.append(toggleBtn, addBtn);
            list.insertAdjacentElement('beforebegin', toolbar);
        } finally {
            this.endMutation();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Group operations                                                    */
    /* ------------------------------------------------------------------ */

    async createGroup() {
        const name = await this.inputPopup(t`Group name`);
        if (!name || !name.trim()) return;

        const data = this.getPresetData();
        data.groups.push({
            id: 'g' + Date.now().toString(36) + Math.floor(performance.now() % 1000).toString(36),
            name: name.trim(),
            collapsed: false,
        });
        this.saveSettings();
        this.apply();
    }

    async renameGroup(groupId) {
        const data = this.getPresetData();
        const group = data.groups.find(g => g.id === groupId);
        if (!group) return;

        const name = await this.inputPopup(t`Group name`, group.name);
        if (!name || !name.trim()) return;

        group.name = name.trim();
        this.saveSettings();
        this.apply();
    }

    async deleteGroup(groupId) {
        const data = this.getPresetData();
        const group = data.groups.find(g => g.id === groupId);
        if (!group) return;

        const ok = await this.confirmPopup(`${t`Delete group`}: ${group.name}?`);
        if (!ok) return;

        data.groups = data.groups.filter(g => g.id !== groupId);
        for (const [id, gid] of Object.entries(data.assignments)) {
            if (gid === groupId) delete data.assignments[id];
        }
        this.saveSettings();
        this.teardown();
        this.apply();
    }

    toggleCollapse(groupId) {
        if (groupId === UNGROUPED_ID) return;
        const data = this.getPresetData();
        const group = data.groups.find(g => g.id === groupId);
        if (!group) return;
        group.collapsed = !group.collapsed;
        this.saveSettings();
        this.apply();
    }

    assignPrompt(identifier, groupId) {
        const data = this.getPresetData();
        if (groupId === null) {
            delete data.assignments[identifier];
        } else {
            data.assignments[identifier] = groupId;
        }
        this.saveSettings();
        this.apply();
    }

    /* ------------------------------------------------------------------ */
    /* Assign menu                                                         */
    /* ------------------------------------------------------------------ */

    openAssignMenu(identifier, anchor) {
        this.closeMenu();

        const data = this.getPresetData();
        const menu = document.createElement('div');
        menu.classList.add('cct-group-menu');

        const addItem = (label, iconClass, onClick, active = false) => {
            const item = document.createElement('div');
            item.classList.add('cct-group-menu-item');
            if (active) item.classList.add('cct-active');
            item.innerHTML = `<i class="fa-solid ${iconClass} fa-xs"></i>`;
            const span = document.createElement('span');
            span.textContent = label;
            item.append(span);
            item.addEventListener('click', () => {
                this.closeMenu();
                onClick();
            });
            menu.append(item);
        };

        const current = data.assignments[identifier];

        for (const group of data.groups) {
            addItem(group.name, current === group.id ? 'fa-check' : 'fa-folder',
                () => this.assignPrompt(identifier, group.id), current === group.id);
        }

        if (current) {
            addItem(t`Remove from group`, 'fa-xmark', () => this.assignPrompt(identifier, null));
        }

        addItem(t`New group`, 'fa-plus', async () => {
            const before = this.getPresetData().groups.length;
            await this.createGroup();
            const groups = this.getPresetData().groups;
            if (groups.length > before) {
                this.assignPrompt(identifier, groups[groups.length - 1].id);
            }
        });

        document.body.append(menu);
        const rect = anchor.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;

        this.menuElement = menu;
    }

    closeMenu() {
        if (this.menuElement) {
            this.menuElement.remove();
            this.menuElement = null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Utilities                                                           */
    /* ------------------------------------------------------------------ */

    setSortableDisabled(disabled) {
        try {
            const $list = globalThis.jQuery?.(LIST_SELECTOR);
            if ($list?.length && $list.sortable('instance')) {
                $list.sortable('option', 'disabled', disabled);
            }
        } catch {
            // Sortable not initialized yet; ignore
        }
    }

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
}
