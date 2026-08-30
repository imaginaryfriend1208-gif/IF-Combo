/**
 * Prompt Picker
 * Replaces the native prompt dropdown in the Chat Completion prompt
 * manager footer with a custom dropdown whose rows carry inline
 * link/delete buttons. The native select and its external link/delete
 * buttons are hidden (not removed) so their ST event handlers can be
 * reused for the actual actions.
 */

import { t } from '../../../../i18n.js';
import { promptManager } from './../../../../openai.js';

const CONTAINER_SELECTOR = '#completion_prompt_manager';
const FOOTER_SELECTOR = '.completion_prompt_manager_footer';
const SELECT_ID = 'completion_prompt_manager_footer_append_prompt';
const ROOT_ID = 'cct-prompt-picker';

export class PromptPickerManager {
    constructor() {
        this.enabled = true;
        this.observer = null;
        this.intervalId = null;
        this.mutating = false;
        this.isOpen = false;
        this.root = null;
        this.toggle = null;
        this.menu = null;

        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.handleDocumentKeydown = this.handleDocumentKeydown.bind(this);

        this.init();
    }

    init() {
        document.addEventListener('click', this.handleDocumentClick, true);
        document.addEventListener('keydown', this.handleDocumentKeydown);

        setTimeout(() => this.apply(), 500);
        this.intervalId = setInterval(() => {
            if (!this.enabled) return;
            if (!document.getElementById(ROOT_ID)) this.apply();
        }, 2000);

        const attachObserver = () => {
            const container = document.querySelector(CONTAINER_SELECTOR);
            if (!container) return false;
            this.observer = new MutationObserver(() => {
                if (this.mutating) return;
                if (!document.getElementById(ROOT_ID)) this.apply();
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

    getFooterParts() {
        const footer = document.querySelector(FOOTER_SELECTOR);
        if (!footer) return null;

        const select = footer.querySelector(`#${SELECT_ID}`);
        const buttons = footer.querySelectorAll('a.menu_button');
        // Template order: [0] chain (link), [1] caution x (delete), ...
        const linkButton = footer.querySelector('a.fa-chain');
        const deleteButton = footer.querySelector('a.caution');
        if (!select || !linkButton || !deleteButton || !buttons.length) return null;

        return { footer, select, linkButton, deleteButton };
    }

    apply() {
        if (!this.enabled) return;

        const parts = this.getFooterParts();
        if (!parts) return;
        if (document.getElementById(ROOT_ID)) return;

        this.mutating = true;

        const { footer, select, linkButton, deleteButton } = parts;

        // Hide the native controls, keep them functional for reuse
        select.classList.add('cct-prompt-picker-hidden');
        linkButton.classList.add('cct-prompt-picker-hidden');
        deleteButton.classList.add('cct-prompt-picker-hidden');

        this.root = document.createElement('div');
        this.root.id = ROOT_ID;
        this.root.classList.add('cct-prompt-picker');

        this.toggle = document.createElement('button');
        this.toggle.type = 'button';
        this.toggle.classList.add('text_pole', 'cct-prompt-picker-toggle');
        this.toggle.setAttribute('aria-haspopup', 'menu');
        this.toggle.setAttribute('aria-expanded', 'false');

        const toggleLabel = document.createElement('span');
        toggleLabel.classList.add('cct-prompt-picker-toggle-label');
        toggleLabel.textContent = t`Select a prompt`;

        const toggleCaret = document.createElement('i');
        toggleCaret.classList.add('fa-solid', 'fa-caret-down');

        this.toggle.append(toggleLabel, toggleCaret);
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

        this.mutating = false;
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
    }

    closeMenu() {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (this.menu) this.menu.hidden = true;
        this.toggle?.setAttribute('aria-expanded', 'false');
    }

    getLinkedIdentifiers() {
        try {
            if (!promptManager?.activeCharacter) return new Set();
            const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
            return new Set(order.map(entry => entry.identifier));
        } catch {
            return new Set();
        }
    }

    renderMenu() {
        if (!this.menu) return;
        this.menu.replaceChildren();

        const parts = this.getFooterParts();
        if (!parts) return;

        const linked = this.getLinkedIdentifiers();
        const options = [...parts.select.options];

        if (!options.length) {
            const empty = document.createElement('div');
            empty.classList.add('cct-prompt-picker-empty');
            empty.textContent = t`No prompts`;
            this.menu.append(empty);
            return;
        }

        for (const option of options) {
            const row = document.createElement('div');
            row.classList.add('cct-prompt-picker-item');
            row.setAttribute('role', 'menuitem');

            const name = document.createElement('span');
            name.classList.add('cct-prompt-picker-item-name');
            name.textContent = option.textContent;
            name.title = option.textContent;

            const actions = document.createElement('div');
            actions.classList.add('cct-prompt-picker-item-actions');

            const isLinked = linked.has(option.value);
            if (!isLinked) {
                const linkAction = document.createElement('button');
                linkAction.type = 'button';
                linkAction.classList.add('cct-prompt-picker-action');
                linkAction.title = t`Insert prompt`;
                linkAction.innerHTML = '<i class="fa-solid fa-link"></i>';
                linkAction.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.runNativeAction(option.value, 'link');
                });
                actions.append(linkAction);
            } else {
                row.classList.add('cct-linked');
                const linkedMark = document.createElement('i');
                linkedMark.classList.add('fa-solid', 'fa-check', 'cct-prompt-picker-linked-mark');
                linkedMark.title = t`Already inserted`;
                actions.append(linkedMark);
            }

            const deleteAction = document.createElement('button');
            deleteAction.type = 'button';
            deleteAction.classList.add('cct-prompt-picker-action', 'cct-prompt-picker-delete');
            deleteAction.title = t`Delete prompt`;
            deleteAction.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
            deleteAction.addEventListener('click', (event) => {
                event.stopPropagation();
                this.runNativeAction(option.value, 'delete');
            });
            actions.append(deleteAction);

            row.append(name, actions);
            this.menu.append(row);
        }
    }

    /**
     * Drives the hidden native controls so ST's own handlers (including
     * its delete confirmation popup) do the actual work.
     */
    runNativeAction(identifier, action) {
        const parts = this.getFooterParts();
        if (!parts) return;

        parts.select.value = identifier;

        if (action === 'link') {
            parts.linkButton.click();
            // ST re-renders the manager; the observer re-applies our UI.
            this.closeMenu();
        } else if (action === 'delete') {
            parts.deleteButton.click();
            this.closeMenu();
        }
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
        const parts = this.getFooterParts();
        if (parts) {
            parts.select.classList.remove('cct-prompt-picker-hidden');
            parts.linkButton.classList.remove('cct-prompt-picker-hidden');
            parts.deleteButton.classList.remove('cct-prompt-picker-hidden');
        }
        document.getElementById(ROOT_ID)?.remove();
        this.root = null;
        this.toggle = null;
        this.menu = null;
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
