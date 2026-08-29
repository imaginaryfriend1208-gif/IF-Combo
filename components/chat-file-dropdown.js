import {
    characters,
    displayPastChats,
    getChat,
    getCurrentChatId,
    getRequestHeaders,
    saveCharacterDebounced,
    this_chid,
} from '../../../../../script.js';
import {
    getGroupPastChats,
    groups,
    openGroupChat,
    selected_group,
} from '../../../../group-chats.js';
import { t } from '../../../../i18n.js';

const ROOT_ID = 'cct-chat-file-dropdown';
const TOP_BAR_SELECTOR = '#top-bar';
const CHARACTER_CHAT_EXTENSION = '.jsonl';

export class ChatFileDropdownManager {
    constructor() {
        this.enabled = true;
        this.root = null;
        this.button = null;
        this.menu = null;
        this.list = null;
        this.isOpen = false;
        this.isSwitching = false;
        this.requestVersion = 0;
        this.mountRetryId = null;
        this.eventBindings = [];

        this.handleDocumentClick = this.handleDocumentClick.bind(this);
        this.handleDocumentKeydown = this.handleDocumentKeydown.bind(this);
        this.handleContextChanged = this.handleContextChanged.bind(this);

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

        if (this.root?.isConnected) {
            this.updateVisibility();
            return;
        }

        const existingRoot = document.getElementById(ROOT_ID);
        if (existingRoot) existingRoot.remove();

        const topBar = document.querySelector(TOP_BAR_SELECTOR);
        if (!topBar) {
            this.scheduleMountRetry();
            return;
        }

        this.root = document.createElement('div');
        this.root.id = ROOT_ID;
        this.root.classList.add('cct-chat-dropdown');

        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.classList.add('menu_button', 'cct-chat-dropdown-toggle');
        this.button.title = t`Chats`;
        this.button.setAttribute('aria-label', t`Chats`);
        this.button.setAttribute('aria-haspopup', 'menu');
        this.button.setAttribute('aria-expanded', 'false');
        this.button.innerHTML = '<i class="fa-solid fa-comments"></i>';
        this.button.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleMenu();
        });

        this.menu = document.createElement('div');
        this.menu.classList.add('cct-chat-dropdown-menu');
        this.menu.setAttribute('role', 'menu');
        this.menu.hidden = true;

        const header = document.createElement('div');
        header.classList.add('cct-chat-dropdown-header');
        header.textContent = t`Chats`;

        this.list = document.createElement('div');
        this.list.classList.add('cct-chat-dropdown-list');

        const manageButton = document.createElement('button');
        manageButton.type = 'button';
        manageButton.classList.add('cct-chat-dropdown-manage');
        manageButton.innerHTML = '<i class="fa-solid fa-folder-open"></i>';
        const manageLabel = document.createElement('span');
        manageLabel.textContent = t`Manage Chat Files`;
        manageButton.append(manageLabel);
        manageButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            this.closeMenu();
            await displayPastChats();
        });

        this.menu.append(header, this.list, manageButton);
        this.root.append(this.button, this.menu);
        topBar.append(this.root);

        this.updateVisibility();
    }

    scheduleMountRetry() {
        if (this.mountRetryId !== null) return;

        let attempts = 0;
        this.mountRetryId = window.setInterval(() => {
            attempts += 1;
            const topBarExists = Boolean(document.querySelector(TOP_BAR_SELECTOR));
            if (!topBarExists && attempts < 20) return;

            clearInterval(this.mountRetryId);
            this.mountRetryId = null;
            if (topBarExists) this.ensureMounted();
        }, 500);
    }

    bindSillyTavernEvents() {
        try {
            const { eventSource, eventTypes } = SillyTavern.getContext();
            if (!eventSource || !eventTypes) return;

            const eventNames = [
                'APP_READY',
                'CHAT_CHANGED',
                'CHAT_CREATED',
                'CHAT_DELETED',
                'CHAT_RENAMED',
                'GROUP_UPDATED',
                'GROUP_CHAT_CREATED',
                'GROUP_CHAT_DELETED',
            ];

            for (const eventName of eventNames) {
                const eventType = eventTypes[eventName];
                if (!eventType) continue;
                eventSource.on(eventType, this.handleContextChanged);
                this.eventBindings.push({ eventSource, eventType });
            }
        } catch {
            // The immediate mount and retry path still initialize the control.
        }
    }

    handleContextChanged() {
        this.requestVersion += 1;
        this.isSwitching = false;
        this.closeMenu();
        this.ensureMounted();
        this.updateVisibility();
    }

    hasCurrentEntity() {
        return selected_group !== null && selected_group !== undefined
            || this_chid !== null && this_chid !== undefined && Boolean(characters[this_chid]);
    }

    updateVisibility() {
        if (!this.root) return;
        const visible = this.enabled && this.hasCurrentEntity();
        this.root.hidden = !visible;
        if (!visible) this.closeMenu();
    }

    async toggleMenu() {
        if (this.isOpen) {
            this.closeMenu();
            return;
        }

        await this.openMenu();
    }

    async openMenu() {
        if (!this.enabled || !this.hasCurrentEntity() || !this.menu || !this.list) return;

        this.isOpen = true;
        this.menu.hidden = false;
        this.button?.setAttribute('aria-expanded', 'true');
        this.renderStatus('loading', t`Loading chats...`);

        const requestVersion = ++this.requestVersion;
        try {
            const chats = await this.loadChats();
            if (!this.isOpen || requestVersion !== this.requestVersion) return;
            this.renderChats(chats);
        } catch (error) {
            if (!this.isOpen || requestVersion !== this.requestVersion) return;
            console.error('[IF Combo] Failed to load chats', error);
            this.renderStatus('error', t`Could not load chats`);
        }
    }

    closeMenu() {
        if (!this.isOpen && this.menu?.hidden) return;
        this.isOpen = false;
        this.requestVersion += 1;
        if (this.menu) this.menu.hidden = true;
        this.button?.setAttribute('aria-expanded', 'false');
    }

    async loadChats() {
        if (selected_group !== null && selected_group !== undefined) {
            return this.loadGroupChats(String(selected_group));
        }

        return this.loadCharacterChats();
    }

    async loadCharacterChats() {
        const character = characters[this_chid];
        if (!character?.avatar) return [];

        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar }),
        });

        if (!response.ok) {
            throw new Error(`Character chats request failed: ${response.status}`);
        }

        const payload = await response.json();
        const activeChatId = getCurrentChatId();
        return Object.values(payload ?? {})
            .map(chat => this.normalizeChat(chat, activeChatId))
            .filter(Boolean)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    async loadGroupChats(groupId) {
        const group = groups.find(item => String(item.id) === groupId);
        if (!group) return [];

        const chats = await getGroupPastChats(groupId);
        return chats
            .map(chat => this.normalizeChat(chat, group.chat_id))
            .filter(Boolean)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    normalizeChat(chat, activeChatId, fallbackId = '') {
        const rawId = chat?.file_name ?? chat?.chat_id ?? fallbackId;
        if (!rawId) return null;

        const id = String(rawId).endsWith(CHARACTER_CHAT_EXTENSION)
            ? String(rawId).slice(0, -CHARACTER_CHAT_EXTENSION.length)
            : String(rawId);
        const activeId = String(activeChatId ?? '').replace(/\.jsonl$/, '');
        const lastMessage = String(chat?.mes ?? '').trim();
        const timestampValue = chat?.last_mes ?? chat?.last_message_date ?? chat?.create_date;
        const timestamp = this.toTimestamp(timestampValue);

        return {
            id,
            label: id,
            lastMessage,
            timestamp,
            isActive: id === activeId,
        };
    }

    toTimestamp(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const timestamp = Date.parse(value ?? '');
        return Number.isFinite(timestamp) ? timestamp : 0;
    }

    renderChats(chats) {
        if (!this.list) return;
        this.list.replaceChildren();

        if (!chats.length) {
            this.renderStatus('empty', t`No chats found`);
            return;
        }

        for (const chat of chats) {
            const item = document.createElement('button');
            item.type = 'button';
            item.classList.add('cct-chat-dropdown-item');
            item.classList.toggle('cct-active', chat.isActive);
            item.setAttribute('role', 'menuitem');
            item.dataset.chatId = chat.id;
            item.disabled = this.isSwitching;

            const icon = document.createElement('i');
            icon.classList.add('fa-solid', chat.isActive ? 'fa-circle-check' : 'fa-message');

            const text = document.createElement('span');
            text.classList.add('cct-chat-dropdown-item-text');

            const name = document.createElement('span');
            name.classList.add('cct-chat-dropdown-item-name');
            name.textContent = chat.label;
            text.append(name);

            if (chat.lastMessage && chat.lastMessage !== chat.label) {
                const preview = document.createElement('span');
                preview.classList.add('cct-chat-dropdown-item-preview');
                preview.textContent = chat.lastMessage;
                text.append(preview);
            }

            item.append(icon, text);
            item.addEventListener('click', () => this.switchChat(chat));
            this.list.append(item);
        }

        this.list.querySelector('.cct-active')?.scrollIntoView({ block: 'nearest' });
    }

    renderStatus(type, text) {
        if (!this.list) return;
        const status = document.createElement('div');
        status.classList.add('cct-chat-dropdown-status', `cct-chat-dropdown-status-${type}`);
        if (type === 'loading') {
            const spinner = document.createElement('i');
            spinner.classList.add('fa-solid', 'fa-spinner', 'fa-spin');
            status.append(spinner);
        }
        const label = document.createElement('span');
        label.textContent = text;
        status.append(label);
        this.list.replaceChildren(status);
    }

    async switchChat(chat) {
        if (this.isSwitching || chat.isActive) {
            this.closeMenu();
            return;
        }

        this.isSwitching = true;
        this.list?.querySelectorAll('button').forEach(button => { button.disabled = true; });

        try {
            if (selected_group !== null && selected_group !== undefined) {
                await openGroupChat(String(selected_group), chat.id);
            } else {
                const character = characters[this_chid];
                if (!character) throw new Error('No character is selected');
                const previousChatId = character.chat;
                character.chat = chat.id;
                try {
                    await getChat();
                    saveCharacterDebounced();
                } catch (error) {
                    character.chat = previousChatId;
                    throw error;
                }
            }
            this.closeMenu();
        } catch (error) {
            console.error('[IF Combo] Failed to switch chat', error);
            this.isSwitching = false;
            this.renderStatus('error', t`Could not open chat`);
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
            this.button?.focus();
        }
    }

    unmount() {
        this.closeMenu();
        this.root?.remove();
        this.root = null;
        this.button = null;
        this.menu = null;
        this.list = null;
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
            eventSource.removeListener?.(eventType, this.handleContextChanged);
        }
        this.eventBindings = [];
        this.unmount();
    }
}
