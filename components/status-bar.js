import { t } from '../../../../i18n.js';

const ROOT_ID = 'cct-status-bar';
const MOUNT_SELECTOR = '#sheld';
const ANCHOR_SELECTOR = '#chat';

/**
 * Horizontal status bar below the top bar showing the active
 * model, chat file, and persona.
 */
export class StatusBarManager {
    constructor() {
        this.enabled = true;
        this.root = null;
        this.apiValue = null;
        this.apiDot = null;
        this.chatValue = null;
        this.personaValue = null;
        this.homeButton = null;
        this.mountRetryId = null;
        this.eventBindings = [];

        this.handleUpdate = this.handleUpdate.bind(this);

        this.init();
    }

    init() {
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

        if (this.root?.isConnected) {
            this.refresh();
            return;
        }

        const existingRoot = document.getElementById(ROOT_ID);
        if (existingRoot) existingRoot.remove();

        const sheld = document.querySelector(MOUNT_SELECTOR);
        if (!sheld) {
            this.scheduleMountRetry();
            return;
        }

        this.root = document.createElement('div');
        this.root.id = ROOT_ID;
        this.root.classList.add('cct-status-bar');

        const api = this.createItem('fa-microchip', t`Model`);
        this.apiDot = document.createElement('span');
        this.apiDot.classList.add('cct-status-bar-dot');
        api.item.prepend(this.apiDot);
        this.apiValue = api.value;

        const chat = this.createItem('fa-message', t`Open chat manager`);
        chat.item.classList.add('cct-status-bar-clickable');
        chat.item.setAttribute('role', 'button');
        chat.item.tabIndex = 0;
        chat.item.addEventListener('click', () => this.openChatManager());
        chat.item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.openChatManager();
            }
        });
        this.chatValue = chat.value;

        const persona = this.createItem('fa-user', t`Persona`);
        this.personaValue = persona.value;

        // Back button next to the persona: closes the current chat and
        // returns to the home screen (welcome message + recent chats).
        this.homeButton = document.createElement('div');
        this.homeButton.classList.add('cct-status-bar-item', 'cct-status-bar-clickable', 'cct-status-bar-home');
        this.homeButton.title = t`Back to home`;
        this.homeButton.setAttribute('role', 'button');
        this.homeButton.tabIndex = 0;
        const homeIcon = document.createElement('i');
        homeIcon.classList.add('fa-solid', 'fa-arrow-left');
        this.homeButton.append(homeIcon);
        this.homeButton.addEventListener('click', () => this.goHome());
        this.homeButton.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.goHome();
            }
        });

        // Persona and back button share the right-hand grid track so the
        // three-column layout (and centered chat name) stays intact.
        const side = document.createElement('div');
        side.classList.add('cct-status-bar-side');
        side.append(persona.item, this.homeButton);

        this.root.append(api.item, chat.item, side);

        // Insert at the top of #sheld, right above the chat log, so the bar
        // sits directly below the top bar without overlapping anything.
        const anchor = sheld.querySelector(ANCHOR_SELECTOR);
        if (anchor) {
            sheld.insertBefore(this.root, anchor);
        } else {
            sheld.prepend(this.root);
        }

        this.refresh();
    }

    createItem(iconClass, title) {
        const item = document.createElement('div');
        item.classList.add('cct-status-bar-item');
        item.title = title;

        const icon = document.createElement('i');
        icon.classList.add('fa-solid', iconClass);

        const value = document.createElement('span');
        value.classList.add('cct-status-bar-value');

        item.append(icon, value);
        return { item, value };
    }

    scheduleMountRetry() {
        if (this.mountRetryId !== null) return;

        let attempts = 0;
        this.mountRetryId = window.setInterval(() => {
            attempts += 1;
            const sheldExists = Boolean(document.querySelector(MOUNT_SELECTOR));
            if (!sheldExists && attempts < 20) return;

            clearInterval(this.mountRetryId);
            this.mountRetryId = null;
            if (sheldExists) this.ensureMounted();
        }, 500);
    }

    bindSillyTavernEvents() {
        try {
            const { eventSource, eventTypes } = SillyTavern.getContext();
            if (!eventSource || !eventTypes) return;

            const eventNames = [
                'APP_READY',
                'CHAT_CHANGED',
                'CHAT_RENAMED',
                'CONNECTION_PROFILE_LOADED',
                'CONNECTION_PROFILE_UPDATED',
                'CONNECTION_PROFILE_DELETED',
                'ONLINE_STATUS_CHANGED',
                'MAIN_API_CHANGED',
                'CHATCOMPLETION_MODEL_CHANGED',
                'PERSONA_CHANGED',
                'SETTINGS_UPDATED',
            ];

            for (const eventName of eventNames) {
                const eventType = eventTypes[eventName];
                if (!eventType) continue;
                eventSource.on(eventType, this.handleUpdate);
                this.eventBindings.push({ eventSource, eventType });
            }
        } catch {
            // The immediate mount and retry path still initialize the control.
        }
    }

    handleUpdate() {
        this.ensureMounted();
        this.refresh();
    }

    refresh() {
        if (!this.root?.isConnected) return;

        const context = SillyTavern.getContext();

        // Active model + online status
        const isConnected = context.onlineStatus && context.onlineStatus !== 'no_connection';
        this.apiValue.textContent = this.getModelName(context) ?? t`No model`;
        this.apiDot.classList.toggle('cct-online', Boolean(isConnected));
        this.apiDot.title = isConnected ? String(context.onlineStatus) : t`Not connected`;

        // Active chat
        const chatId = context.getCurrentChatId();
        this.chatValue.textContent = chatId ? this.getChatDisplayName(String(chatId)) : t`No chat`;
        this.chatValue.parentElement.title = chatId ? String(chatId) : t`Open chat manager`;

        // Persona
        this.personaValue.textContent = context.name1 || t`No persona`;

        // Back button is only meaningful while a chat is open
        this.homeButton.classList.toggle('cct-status-bar-disabled', !chatId);
        this.homeButton.setAttribute('aria-disabled', String(!chatId));
    }

    getModelName(context) {
        // Chat Completion exposes the model via a dedicated getter.
        if (context.mainApi === 'openai') {
            const model = context.getChatCompletionModel?.();
            if (model) return String(model);
        }

        // For other APIs the online status holds the model name once connected.
        const status = String(context.onlineStatus ?? '');
        if (status && status !== 'no_connection' && status !== 'Connected') {
            return status;
        }

        return null;
    }

    getChatDisplayName(chatId) {
        // Strip the auto-generated timestamp suffix,
        // e.g. "Seraphina - 2026-08-29@23h49m33s779ms" -> "Seraphina".
        const trimmed = chatId
            .replace(/\s*-\s*\d{4}-\d{1,2}-\d{1,2}\s*@.*$/, '')
            .replace(/\s*@\d{2}h\s*\d{2}m\s*\d{2}s.*$/, '')
            .trim();
        return trimmed || chatId;
    }

    openChatManager() {
        const optionButton = document.getElementById('option_select_chat');
        if (!optionButton) return;
        optionButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    goHome() {
        if (this.homeButton?.classList.contains('cct-status-bar-disabled')) return;

        // Same action as "Close chat" in the options menu: clears the
        // current chat and shows the welcome screen with recent chats.
        const optionButton = document.getElementById('option_close_chat');
        if (!optionButton) return;
        optionButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    unmount() {
        this.root?.remove();
        this.root = null;
        this.apiValue = null;
        this.apiDot = null;
        this.chatValue = null;
        this.personaValue = null;
        this.homeButton = null;
    }

    destroy() {
        this.enabled = false;
        if (this.mountRetryId !== null) {
            clearInterval(this.mountRetryId);
            this.mountRetryId = null;
        }
        for (const { eventSource, eventType } of this.eventBindings) {
            eventSource.removeListener?.(eventType, this.handleUpdate);
        }
        this.eventBindings = [];
        this.unmount();
    }
}
