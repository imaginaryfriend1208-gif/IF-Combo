/**
 * Character Delete
 * - Adds "Also delete lorebook" checkboxes to ST's delete-character popup for
 *   every lorebook linked to the character (primary and additional books).
 *   The books are deleted through ST's deleteWorldInfo only after ST has
 *   finished deleting the character.
 * - Adds a quick delete button to each row of the character list. It opens
 *   ST's own delete confirmation and calls ST's deleteCharacter.
 */

import { t } from '../../../../i18n.js';
import { deleteCharacter } from '../../../../../script.js';
import { renderTemplateAsync } from '../../../../templates.js';
import { Popup, POPUP_RESULT } from '../../../../popup.js';
import { power_user } from '../../../../power-user.js';
import { escapeHtml } from '../../../../utils.js';
import { deleteWorldInfo, selected_world_info, world_info, world_names } from '../../../../world-info.js';

const LIST_SELECTOR = '#rm_print_characters_block';
const CHAT_CHECKBOX_SELECTOR = '#del_char_checkbox';
// The bulk delete popup reuses the chat checkbox id; it is left untouched.
const BULK_POPUP_SELECTOR = '#bulk_delete_options';
const BOOKS_CLASS = 'cct-char-delete-books';
const QUICK_DELETE_CLASS = 'cct-char-quick-delete';
// Ticked books are ignored if ST does not delete the character within this time.
const PENDING_TTL_MS = 2 * 60 * 1000;

function getFileName(avatar) {
    return String(avatar ?? '').replace(/\.[^/.]+$/, '');
}

export class CharacterDeleteManager {
    constructor() {
        this.enabled = true;
        this.popupObserver = null;
        this.listObserver = null;
        this.listRetryId = null;
        this.mutating = false;
        this.quickTarget = null;
        this.popupState = null; // delete popup currently showing lorebook checkboxes
        this.pending = null; // lorebook names to delete once ST has removed the character
        this.eventBindings = [];

        this.handleCharacterDeleted = this.handleCharacterDeleted.bind(this);
        this.handleChatChanged = this.handleChatChanged.bind(this);

        this.init();
    }

    init() {
        this.popupObserver = new MutationObserver((mutations) => {
            if (!this.enabled) return;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node instanceof HTMLElement) this.decoratePopup(node);
                }
            }
        });
        this.popupObserver.observe(document.body, { childList: true });

        this.bindSillyTavernEvents();
        this.attachListObserver();
    }

    bindSillyTavernEvents() {
        try {
            const { eventSource, eventTypes } = SillyTavern.getContext();
            if (!eventSource || !eventTypes) return;
            const bindings = [
                [eventTypes.CHARACTER_DELETED, this.handleCharacterDeleted],
                [eventTypes.CHAT_CHANGED, this.handleChatChanged],
            ];
            for (const [eventType, handler] of bindings) {
                if (!eventType) continue;
                eventSource.on(eventType, handler);
                this.eventBindings.push({ eventSource, eventType, handler });
            }
        } catch {
            // Without the events no lorebook is ever deleted.
        }
    }

    attachListObserver() {
        const attach = () => {
            const list = document.querySelector(LIST_SELECTOR);
            if (!list) return false;
            this.listObserver = new MutationObserver(() => {
                if (this.mutating || !this.enabled) return;
                this.decorateList();
            });
            this.listObserver.observe(list, { childList: true, subtree: true });
            this.decorateList();
            return true;
        };

        if (!attach()) {
            this.listRetryId = setInterval(() => {
                if (attach()) {
                    clearInterval(this.listRetryId);
                    this.listRetryId = null;
                }
            }, 1000);
        }
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (enabled) {
            this.decorateList();
        } else {
            this.popupState = null;
            this.pending = null;
            this.removeListButtons();
        }
    }

    // -- Lorebooks --------------------------------------------------------

    /** Lorebooks linked to the character that still exist. */
    getCharacterBooks(character) {
        const fileName = getFileName(character.avatar);
        const names = [];
        const primary = character.data?.extensions?.world;
        if (primary) names.push(primary);
        const extra = world_info.charLore?.find((e) => e.name === fileName)?.extraBooks;
        if (Array.isArray(extra)) names.push(...extra);
        const existing = Array.isArray(world_names) ? world_names : [];
        return [...new Set(names)].filter((name) => name && existing.includes(name));
    }

    /** Other places that use the lorebook, so the user knows it is shared. */
    getBookUsers(name, character) {
        const { characters } = SillyTavern.getContext();
        const ownFileName = getFileName(character.avatar);
        const users = new Set();

        for (const other of characters) {
            if (other.avatar !== character.avatar && other.data?.extensions?.world === name) {
                users.add(other.name);
            }
        }
        for (const lore of world_info.charLore ?? []) {
            if (lore.name === ownFileName || !lore.extraBooks?.includes(name)) continue;
            const other = characters.find((c) => getFileName(c.avatar) === lore.name);
            if (other) users.add(other.name);
        }
        if (selected_world_info?.includes(name)) users.add(t`Global lorebooks`);
        const personaBooks = Object.values(power_user.persona_descriptions ?? {}).map((d) => d?.lorebook);
        if (power_user.persona_description_lorebook === name || personaBooks.includes(name)) {
            users.add(t`Persona`);
        }
        return [...users];
    }

    /**
     * Adds lorebook checkboxes to ST's delete-character popup and remembers
     * the ticked books once the popup is confirmed.
     */
    decoratePopup(dlg) {
        const chatCheckbox = dlg.querySelector(CHAT_CHECKBOX_SELECTOR);
        if (!chatCheckbox || dlg.querySelector(BULK_POPUP_SELECTOR) || dlg.querySelector(`.${BOOKS_CLASS}`)) return;

        const context = SillyTavern.getContext();
        const avatar = this.quickTarget ?? context.characters[context.characterId]?.avatar;
        const character = context.characters.find((c) => c.avatar === avatar);
        if (!character) return;

        this.popupState = null;
        const books = this.getCharacterBooks(character);
        if (!books.length) return;

        // The popup registers itself before it is shown; ST drops it from
        // this list as soon as it closes, so keep the instance now. Its
        // result tells whether the deletion was confirmed.
        const popup = Popup.util?.popups?.find((p) => p.dlg === dlg);
        if (!popup) return;

        const block = document.createElement('div');
        block.classList.add(BOOKS_CLASS);
        for (const name of books) {
            const label = document.createElement('label');
            label.classList.add('checkbox_label', 'justifyCenter');

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.book = name;

            const text = document.createElement('small');
            text.append(`${t`Also delete lorebook`}: `);
            const bookName = document.createElement('b');
            bookName.textContent = name;
            text.append(bookName);

            label.append(checkbox, text);
            block.append(label);

            const users = this.getBookUsers(name, character);
            if (users.length) {
                const note = document.createElement('small');
                note.classList.add('cct-char-delete-books-note');
                note.textContent = `${t`Also used by`}: ${users.join(', ')}`;
                block.append(note);
            }
        }
        (chatCheckbox.closest('label') ?? chatCheckbox).insertAdjacentElement('afterend', block);

        this.popupState = {
            avatar: character.avatar,
            popup,
            block,
            expires: Date.now() + PENDING_TTL_MS,
        };
    }

    /** Picks up the ticked books once ST has deleted the character. */
    handleCharacterDeleted(event) {
        const state = this.popupState;
        if (!state || event?.character?.avatar !== state.avatar) return;
        this.popupState = null;
        if (Date.now() > state.expires) return;
        if (state.popup.result !== POPUP_RESULT.AFFIRMATIVE) return;

        const selected = [...state.block.querySelectorAll('input[data-book]:checked')].map((el) => el.dataset.book);
        if (selected.length) this.pending = selected;
    }

    // ST emits CHAT_CHANGED after it has removed the deleted character from
    // the UI, so the character editor no longer holds the lorebook.
    async handleChatChanged() {
        await this.deletePendingBooks();
    }

    async deletePendingBooks() {
        const books = this.pending;
        if (!books) return;
        this.pending = null;

        const context = SillyTavern.getContext();
        const deleted = [];
        const failed = [];

        for (const name of books) {
            // Keep deleteWorldInfo from re-saving a character editor that
            // still shows this lorebook.
            const characterWorld = document.getElementById('character_world');
            if (characterWorld && characterWorld.value === name) characterWorld.value = '';

            // Same cleanup ST does when a lorebook is deleted from its editor
            if (Array.isArray(world_info.charLore)) {
                for (let i = world_info.charLore.length - 1; i >= 0; i--) {
                    const lore = world_info.charLore[i];
                    if (!lore.extraBooks?.includes(name)) continue;
                    const rest = lore.extraBooks.filter((e) => e !== name);
                    if (rest.length) {
                        lore.extraBooks = rest;
                    } else {
                        world_info.charLore.splice(i, 1);
                    }
                }
            }

            try {
                if (await deleteWorldInfo(name)) {
                    deleted.push(name);
                } else {
                    failed.push(name);
                }
            } catch (error) {
                console.error('[IF Combo] Failed to delete lorebook', name, error);
                failed.push(name);
            }
        }

        context.saveSettingsDebounced();
        if (deleted.length) toastr.success(deleted.join(', '), t`Lorebook deleted`);
        if (failed.length) toastr.warning(failed.join(', '), t`Lorebook was not deleted`);
    }

    // -- Quick delete in the character list -------------------------------

    decorateList() {
        if (!this.enabled) return;
        const list = document.querySelector(LIST_SELECTOR);
        if (!list) return;

        this.mutating = true;
        try {
            for (const row of list.querySelectorAll('.character_select[data-chid]')) {
                if (row.querySelector(`.${QUICK_DELETE_CLASS}`)) continue;
                row.append(this.createQuickDeleteButton(row));
            }
        } finally {
            // Observer callbacks run as microtasks after these DOM changes
            queueMicrotask(() => { this.mutating = false; });
        }
    }

    createQuickDeleteButton(row) {
        const button = document.createElement('div');
        button.classList.add(QUICK_DELETE_CLASS, 'fa-solid', 'fa-trash-can');
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        button.title = t`Delete character`;

        const run = (event) => {
            // Keep ST's row click handler from opening the character
            event.preventDefault();
            event.stopPropagation();
            this.quickDelete(row.dataset.chid);
        };
        button.addEventListener('click', run);
        button.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') run(event);
        });
        return button;
    }

    removeListButtons() {
        this.mutating = true;
        document.querySelectorAll(`.${QUICK_DELETE_CLASS}`).forEach((el) => el.remove());
        queueMicrotask(() => { this.mutating = false; });
    }

    async quickDelete(chid) {
        const context = SillyTavern.getContext();
        const character = context.characters[chid];
        if (!character) return;

        let deleteChats = false;
        let confirmed;
        this.quickTarget = character.avatar;
        try {
            const content = await renderTemplateAsync('deleteConfirm');
            confirmed = await Popup.show.confirm(
                `${t`Delete the character?`} ${escapeHtml(character.name)}`,
                content,
                {
                    onClose: (popup) => {
                        deleteChats = !!popup.dlg.querySelector(CHAT_CHECKBOX_SELECTOR)?.checked;
                    },
                },
            );
        } finally {
            this.quickTarget = null;
        }
        if (!confirmed) return;

        const deletedCharacter = await deleteCharacter(character.avatar, { deleteChats });
        if (deletedCharacter) await this.deletePendingBooks();
    }

    destroy() {
        this.enabled = false;
        this.popupState = null;
        this.pending = null;
        this.popupObserver?.disconnect();
        this.listObserver?.disconnect();
        if (this.listRetryId) clearInterval(this.listRetryId);
        for (const { eventSource, eventType, handler } of this.eventBindings) {
            eventSource.removeListener?.(eventType, handler);
        }
        this.eventBindings = [];
        this.removeListButtons();
    }
}
