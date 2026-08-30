/**
 * Input History
 * Adds a button next to the send button that reopens previously sent
 * inputs. Inputs are captured when generation starts and stored in
 * localStorage. Inspired by LenAnderson/SillyTavern-InputHistory.
 */

import { t } from '../../../../i18n.js';

const ROOT_ID = 'cct-input-history';
const MENU_ID = 'cct-input-history-menu';
const TEXTAREA_SELECTOR = '#send_textarea';
const RIGHT_FORM_SELECTOR = '#rightSendForm';
const SEND_BUTTON_SELECTOR = '#send_but';
const FORM_SELECTOR = '#nonQRFormItems';
const STORAGE_KEY = 'cct--inputHistory';
const MAX_HISTORY = 20;

export class InputHistoryManager {
    constructor() {
        this.enabled = true;
        this.button = null;
        this.menu = null;
        this.isOpen = false;
        this.lastTypedValue = '';
        this.mountRetryId = null;
        this.eventBindings = [];

        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.handleDocumentKeydown = this.handleDocumentKeydown.bind(this);
        this.handleGenerationStarted = this.handleGenerationStarted.bind(this);
        this.handleTextareaInput = this.handleTextareaInput.bind(this);

        this.init();
    }

    init() {
        document.addEventListener('click', this.handleDocumentClick, true);
        document.addEventListener('keydown', this.handleDocumentKeydown);
        this.bindSillyTavernEvents();
        this.ensureMounted();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.unmount();
            return;
        }

        this.ensureMounted();
    }

    ensureMounted() {
        if (!this.enabled) return;
        if (this.button?.isConnected) return;

        document.getElementById(ROOT_ID)?.remove();

        const rightForm = document.querySelector(RIGHT_FORM_SELECTOR);
        const textarea = document.querySelector(TEXTAREA_SELECTOR);
        if (!rightForm || !textarea) {
            this.scheduleMountRetry();
            return;
        }

        this.button = document.createElement('div');
        this.button.id = ROOT_ID;
        this.button.classList.add('fa-solid', 'fa-clock-rotate-left', 'interactable');
        this.button.title = t`Input history`;
        this.button.tabIndex = 0;
        this.button.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleMenu();
        });

        const sendButton = rightForm.querySelector(SEND_BUTTON_SELECTOR);
        if (sendButton) {
            rightForm.insertBefore(this.button, sendButton);
        } else {
            rightForm.append(this.button);
        }

        textarea.removeEventListener('input', this.handleTextareaInput);
        textarea.addEventListener('input', this.handleTextareaInput);
    }

    scheduleMountRetry() {
        if (this.mountRetryId !== null) return;

        let attempts = 0;
        this.mountRetryId = window.setInterval(() => {
            attempts += 1;
            const formExists = Boolean(document.querySelector(RIGHT_FORM_SELECTOR));
            if (!formExists && attempts < 20) return;

            clearInterval(this.mountRetryId);
            this.mountRetryId = null;
            if (formExists) this.ensureMounted();
        }, 500);
    }

    bindSillyTavernEvents() {
        try {
            const { eventSource, eventTypes } = SillyTavern.getContext();
            if (!eventSource || !eventTypes) return;

            const eventType = eventTypes.GENERATION_STARTED;
            if (!eventType) return;
            eventSource.on(eventType, this.handleGenerationStarted);
            this.eventBindings.push({ eventSource, eventType });
        } catch {
            // History capture degrades gracefully; the button still works.
        }
    }

    /**
     * The textarea is already cleared when GENERATION_STARTED fires,
     * so the last non-empty typed value is tracked on input instead.
     */
    handleTextareaInput(event) {
        const value = event.target?.value;
        if (typeof value === 'string' && value.trim() !== '') {
            this.lastTypedValue = value;
        }
    }

    handleGenerationStarted() {
        this.addToHistory(this.lastTypedValue);
        this.lastTypedValue = '';
    }

    getHistory() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
            return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
        } catch {
            return [];
        }
    }

    setHistory(history) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        } catch {
            // localStorage may be unavailable; history is best-effort.
        }
    }

    addToHistory(text) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) return;

        const history = this.getHistory();
        const existingIndex = history.indexOf(trimmed);
        if (existingIndex !== -1) history.splice(existingIndex, 1);
        history.unshift(trimmed);
        while (history.length > MAX_HISTORY) history.pop();
        this.setHistory(history);
    }

    toggleMenu() {
        if (this.isOpen) {
            this.closeMenu();
        } else {
            this.openMenu();
        }
    }

    openMenu() {
        const form = document.querySelector(FORM_SELECTOR);
        if (!form) return;

        this.closeMenu();

        this.menu = document.createElement('div');
        this.menu.id = MENU_ID;
        this.menu.classList.add('cct-input-history-menu');
        this.menu.setAttribute('role', 'menu');

        const history = this.getHistory();
        if (!history.length) {
            const empty = document.createElement('div');
            empty.classList.add('cct-input-history-empty');
            empty.textContent = t`No previous inputs`;
            this.menu.append(empty);
        }

        for (const text of history) {
            const item = document.createElement('button');
            item.type = 'button';
            item.classList.add('cct-input-history-item');
            item.setAttribute('role', 'menuitem');
            item.title = text;

            const icon = document.createElement('i');
            icon.classList.add('fa-solid', text.startsWith('/') ? 'fa-terminal' : 'fa-comment');

            const label = document.createElement('span');
            label.classList.add('cct-input-history-item-text');
            label.textContent = text;

            item.append(icon, label);
            item.addEventListener('click', () => {
                this.closeMenu();
                this.restoreInput(text);
            });
            this.menu.append(item);
        }

        form.append(this.menu);
        this.isOpen = true;
        this.button?.classList.add('cct-active');
    }

    closeMenu() {
        this.isOpen = false;
        this.menu?.remove();
        this.menu = null;
        this.button?.classList.remove('cct-active');
    }

    restoreInput(text) {
        const textarea = document.querySelector(TEXTAREA_SELECTOR);
        if (!textarea) return;
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    handleDocumentClick(event) {
        if (this.isOpen && this.menu && !this.menu.contains(event.target) && event.target !== this.button) {
            this.closeMenu();
        }
    }

    handleDocumentKeydown(event) {
        if (event.key === 'Escape' && this.isOpen) {
            this.closeMenu();
            this.button?.focus();
        }
    }

    unmount() {
        this.closeMenu();
        this.button?.remove();
        this.button = null;
        document.querySelector(TEXTAREA_SELECTOR)?.removeEventListener('input', this.handleTextareaInput);
    }

    destroy() {
        this.enabled = false;
        if (this.mountRetryId !== null) {
            clearInterval(this.mountRetryId);
            this.mountRetryId = null;
        }
        document.removeEventListener('click', this.handleDocumentClick, true);
        document.removeEventListener('keydown', this.handleDocumentKeydown);
        for (const { eventSource, eventType } of this.eventBindings) {
            eventSource.removeListener?.(eventType, this.handleGenerationStarted);
        }
        this.eventBindings = [];
        this.unmount();
    }
}
