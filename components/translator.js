/**
 * Translator
 * Translates a whole chat message or just the highlighted text with an LLM
 * taken from a saved Connection Manager profile. Adds a standalone
 * "Translate" button to every message's action row and a small floating
 * button that appears when text inside a message is selected.
 *
 * Message translations are stored in `message.extra.display_text`, the same
 * field SillyTavern's own translate extension uses, so the message renders
 * the translation while the original text sent to the model is untouched.
 */

import { t } from '../../../../i18n.js';

const SETTINGS_PREFIX = 'cct-translator';
const BUTTON_CLASS = 'cct-translate';
const BUBBLE_ID = 'cct-translate-bubble';
const TRANSLATION_KEY = 'cct_translation';
const DEFAULT_PROMPT_ID = 'default';

export const DEFAULT_TRANSLATE_PROMPT = [
    'You are a professional literary translator. Translate the text into {{language}}.',
    'Preserve the original meaning, tone, register and point of view. Keep character names, markdown, line breaks, quotation marks, asterisks, emphasis and any HTML tags exactly as they are.',
    'Do not summarize, censor, add notes, explanations or commentary. Output only the translated text.',
].join('\n');

export class TranslatorManager {
    /**
     * @param {object} options
     * @param {() => object} options.getSettings - returns translator settings
     *   { profileId, targetLanguage, maxTokens, prompts: [{id,name,text}], activePromptId, selectionBubble }
     * @param {() => void} options.saveSettings - persists settings
     */
    constructor({ getSettings, saveSettings }) {
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;

        this.enabled = true;
        this.observer = null;
        this.intervalId = null;
        this.inFlight = new Set();
        this.pendingSelection = '';
        this.bubble = null;
        this.selectionTimer = null;

        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleClick = this.handleClick.bind(this);
        this.handleSelectionChange = this.handleSelectionChange.bind(this);
        this.hideBubble = this.hideBubble.bind(this);

        this.ensurePromptList();
        this.init();
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    init() {
        document.addEventListener('mousedown', this.handleMouseDown, true);
        document.addEventListener('click', this.handleClick, true);
        document.addEventListener('selectionchange', this.handleSelectionChange);
        window.addEventListener('scroll', this.hideBubble, true);

        setTimeout(() => this.apply(), 500);
        this.intervalId = setInterval(() => {
            if (this.enabled) this.apply();
        }, 2000);

        const attachObserver = () => {
            const chat = document.getElementById('chat');
            if (!chat) return false;
            this.observer = new MutationObserver(() => {
                if (this.enabled) this.apply();
            });
            this.observer.observe(chat, { childList: true });
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

    /* ------------------------------------------------------------------ */
    /* Message buttons                                                     */
    /* ------------------------------------------------------------------ */

    apply() {
        if (!this.enabled) return;

        // Template first so that newly rendered messages already carry the button
        const template = document.querySelector('#message_template .mes_buttons');
        if (template) this.ensureButton(template);

        const context = SillyTavern.getContext();
        document.querySelectorAll('#chat .mes').forEach((mes) => {
            const buttons = mes.querySelector('.mes_buttons');
            if (!buttons) return;
            const button = this.ensureButton(buttons);
            const id = Number(mes.getAttribute('mesid'));
            const message = context.chat?.[id];
            const shown = !!message?.extra?.display_text && message.extra.display_text === message.extra[TRANSLATION_KEY];
            button.classList.toggle('cct-active', shown);
            button.classList.toggle('cct-busy', this.inFlight.has(id));
            button.title = shown ? t`Show original` : t`Translate message (select text to translate only the selection)`;
        });
    }

    ensureButton(buttonsRow) {
        let button = buttonsRow.querySelector(`.${BUTTON_CLASS}`);
        if (button) return button;

        button = document.createElement('div');
        button.classList.add('mes_button', BUTTON_CLASS, 'fa-solid', 'fa-language');
        button.title = t`Translate message (select text to translate only the selection)`;

        // Standalone, in the main row right before the edit button
        const edit = buttonsRow.querySelector('.mes_edit');
        if (edit) {
            edit.insertAdjacentElement('beforebegin', button);
        } else {
            buttonsRow.append(button);
        }
        return button;
    }

    teardown() {
        this.hideBubble();
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach(el => el.remove());
    }

    /* ------------------------------------------------------------------ */
    /* Events                                                              */
    /* ------------------------------------------------------------------ */

    handleMouseDown(event) {
        if (!this.enabled) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest(`.${BUTTON_CLASS}`) || target.closest(`#${BUBBLE_ID}`)) {
            // Remember the selection before the click collapses it
            this.pendingSelection = this.getSelectedText();
            event.preventDefault();
        }
    }

    handleClick(event) {
        if (!this.enabled) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const button = target.closest(`.${BUTTON_CLASS}`);
        if (button) {
            event.preventDefault();
            event.stopPropagation();
            const mes = button.closest('.mes');
            const id = Number(mes?.getAttribute('mesid'));
            const selection = this.pendingSelection;
            this.pendingSelection = '';
            if (selection) {
                this.translateSelection(selection);
            } else if (Number.isInteger(id)) {
                this.toggleMessageTranslation(id, event.shiftKey);
            }
            return;
        }

        if (target.closest(`#${BUBBLE_ID}`)) {
            event.preventDefault();
            event.stopPropagation();
            const selection = this.pendingSelection || this.getSelectedText();
            this.pendingSelection = '';
            this.hideBubble();
            if (selection) this.translateSelection(selection);
        }
    }

    getSelectedText() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return '';
        return selection.toString().trim();
    }

    /** True when the selection starts inside a chat message body. */
    isSelectionInChat() {
        const selection = window.getSelection();
        const node = selection?.anchorNode;
        const element = node instanceof Element ? node : node?.parentElement;
        return !!element?.closest('#chat .mes_text');
    }

    /* ------------------------------------------------------------------ */
    /* Floating bubble                                                     */
    /* ------------------------------------------------------------------ */

    handleSelectionChange() {
        if (!this.enabled || this.getSettings().selectionBubble === false) return;
        clearTimeout(this.selectionTimer);
        this.selectionTimer = setTimeout(() => {
            const text = this.getSelectedText();
            if (!text || !this.isSelectionInChat()) {
                this.hideBubble();
                return;
            }
            this.showBubble();
        }, 250);
    }

    showBubble() {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;

        if (!this.bubble) {
            this.bubble = document.createElement('div');
            this.bubble.id = BUBBLE_ID;
            this.bubble.title = t`Translate selection`;
            this.bubble.innerHTML = '<i class="fa-solid fa-language"></i>';
            document.body.append(this.bubble);
        }

        const margin = 6;
        const width = this.bubble.offsetWidth || 32;
        const height = this.bubble.offsetHeight || 32;
        let left = rect.left + rect.width / 2 - width / 2;
        left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
        let top = rect.top - height - margin;
        if (top < margin) top = rect.bottom + margin;

        this.bubble.style.left = `${left}px`;
        this.bubble.style.top = `${top}px`;
        this.bubble.classList.add('cct-visible');
    }

    hideBubble() {
        this.bubble?.classList.remove('cct-visible');
    }

    /* ------------------------------------------------------------------ */
    /* Translation actions                                                 */
    /* ------------------------------------------------------------------ */

    async toggleMessageTranslation(messageId, force = false) {
        const context = SillyTavern.getContext();
        const message = context.chat?.[messageId];
        if (!message) return;
        if (this.inFlight.has(messageId)) return;
        if (typeof message.extra !== 'object' || message.extra === null) message.extra = {};

        const cached = message.extra[TRANSLATION_KEY];
        const showing = !!message.extra.display_text && message.extra.display_text === cached;

        if (!force && showing) {
            // Translation visible -> show original
            delete message.extra.display_text;
            context.updateMessageBlock?.(messageId, message);
            this.apply();
            await context.saveChat();
            return;
        }

        if (!force && cached) {
            // Original visible, translation cached -> show translation again
            message.extra.display_text = cached;
            context.updateMessageBlock?.(messageId, message);
            this.apply();
            await context.saveChat();
            return;
        }

        const source = String(message.mes ?? '');
        if (!source.trim()) return;

        this.inFlight.add(messageId);
        this.apply();
        try {
            const translation = await this.translate(source, message.name);
            if (!translation) return;
            message.extra[TRANSLATION_KEY] = translation;
            message.extra.display_text = translation;
            context.updateMessageBlock?.(messageId, message);
            await context.saveChat();
        } catch (error) {
            console.error('[IF Combo] Translation failed', error);
            toastr.error(String(error?.cause?.message || error?.message || error), t`Translation failed`);
        } finally {
            this.inFlight.delete(messageId);
            this.apply();
        }
    }

    async translateSelection(text) {
        const source = String(text ?? '').trim();
        if (!source) return;

        const key = `sel:${source}`;
        if (this.inFlight.has(key)) return;
        this.inFlight.add(key);

        toastr.info(t`Translating...`, 'IF Combo', { timeOut: 1500 });
        try {
            const translation = await this.translate(source);
            if (!translation) return;
            await this.showResultPopup(source, translation);
        } catch (error) {
            console.error('[IF Combo] Translation failed', error);
            toastr.error(String(error?.cause?.message || error?.message || error), t`Translation failed`);
        } finally {
            this.inFlight.delete(key);
        }
    }

    async showResultPopup(source, translation) {
        const context = SillyTavern.getContext();

        const wrapper = document.createElement('div');
        wrapper.classList.add('cct-translate-result');

        const translated = document.createElement('div');
        translated.classList.add('cct-translate-result-text');
        translated.textContent = translation;

        const details = document.createElement('details');
        details.classList.add('cct-translate-result-source');
        const summary = document.createElement('summary');
        summary.textContent = t`Original text`;
        const original = document.createElement('div');
        original.classList.add('cct-translate-result-text');
        original.textContent = source;
        details.append(summary, original);

        wrapper.append(translated, details);

        try {
            if (context.callGenericPopup && context.POPUP_TYPE) {
                await context.callGenericPopup(wrapper, context.POPUP_TYPE.TEXT, '', {
                    wide: true,
                    allowVerticalScrolling: true,
                    okButton: t`Close`,
                });
                return;
            }
        } catch {
            // Fall through
        }
        window.alert(translation);
    }

    /* ------------------------------------------------------------------ */
    /* Request                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * @param {string} text
     * @param {string} [speaker] message author name, exposed to the prompt as {{name}}
     * @returns {Promise<string>}
     */
    async translate(text, speaker = '') {
        const settings = this.getSettings();
        const context = SillyTavern.getContext();
        const service = context.ConnectionManagerRequestService;
        if (!service) throw new Error('Connection Manager is not available');
        if (!settings.profileId) throw new Error(t`Translator: no connection profile selected.`);

        const profile = service.getProfile(settings.profileId);
        if (!profile) throw new Error('Selected connection profile no longer exists');

        const language = String(settings.targetLanguage || 'English').trim();
        const promptTemplate = this.getActivePrompt().text || DEFAULT_TRANSLATE_PROMPT;
        const substitute = (s) => s
            .replace(/{{\s*(language|target|target_language)\s*}}/gi, language)
            .replace(/{{\s*name\s*}}/gi, speaker || '');

        const messages = [];
        if (/{{\s*text\s*}}/i.test(promptTemplate)) {
            messages.push({ role: 'user', content: substitute(promptTemplate).replace(/{{\s*text\s*}}/gi, text) });
        } else {
            messages.push({ role: 'system', content: substitute(promptTemplate) });
            messages.push({ role: 'user', content: text });
        }

        const maxTokens = Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : 4096;

        const result = await service.sendRequest(
            settings.profileId,
            /** @type {any} */ (messages),
            maxTokens,
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
        );

        const out = typeof result === 'string' ? result : result?.content;
        return String(out ?? '').trim();
    }

    /* ------------------------------------------------------------------ */
    /* Prompt presets                                                      */
    /* ------------------------------------------------------------------ */

    ensurePromptList() {
        const settings = this.getSettings();
        if (!Array.isArray(settings.prompts) || !settings.prompts.length) {
            settings.prompts = [{ id: DEFAULT_PROMPT_ID, name: t`Default`, text: DEFAULT_TRANSLATE_PROMPT }];
        }
        if (!settings.prompts.some(p => p.id === settings.activePromptId)) {
            settings.activePromptId = settings.prompts[0].id;
        }
    }

    getActivePrompt() {
        this.ensurePromptList();
        const settings = this.getSettings();
        return settings.prompts.find(p => p.id === settings.activePromptId) ?? settings.prompts[0];
    }

    /* ------------------------------------------------------------------ */
    /* Settings UI                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Renders the Translator controls into the IF Combo settings drawer.
     * @param {HTMLElement} container
     */
    renderSettings(container) {
        if (!container || container.querySelector(`#${SETTINGS_PREFIX}-block`)) return;
        const settings = this.getSettings();
        this.ensurePromptList();

        const block = document.createElement('div');
        block.id = `${SETTINGS_PREFIX}-block`;
        block.classList.add('cct-translator-block');

        const hint = document.createElement('small');
        hint.classList.add('cct-translator-hint');
        hint.textContent = t`Translates a message (button in the message action row) or the highlighted text with the model from a saved connection profile.`;
        block.append(hint);

        // Profile
        const profileLabel = document.createElement('label');
        profileLabel.textContent = t`Translation connection profile`;
        const profileSelect = document.createElement('select');
        profileSelect.id = `${SETTINGS_PREFIX}-profile`;
        profileSelect.classList.add('text_pole');
        this.populateProfiles(profileSelect, settings.profileId);
        profileSelect.addEventListener('focus', () => this.populateProfiles(profileSelect, this.getSettings().profileId));
        profileSelect.addEventListener('change', () => {
            settings.profileId = profileSelect.value || null;
            this.saveSettings();
        });
        profileLabel.append(profileSelect);
        block.append(profileLabel);

        // Target language
        const langLabel = document.createElement('label');
        langLabel.textContent = t`Target language`;
        const langInput = document.createElement('input');
        langInput.type = 'text';
        langInput.classList.add('text_pole');
        langInput.placeholder = 'Vietnamese';
        langInput.value = String(settings.targetLanguage ?? '');
        langInput.addEventListener('input', () => {
            settings.targetLanguage = langInput.value;
            this.saveSettings();
        });
        langLabel.append(langInput);
        block.append(langLabel);

        // Max tokens
        const tokensLabel = document.createElement('label');
        tokensLabel.textContent = t`Max translation tokens`;
        const tokensInput = document.createElement('input');
        tokensInput.type = 'number';
        tokensInput.min = '64';
        tokensInput.step = '64';
        tokensInput.classList.add('text_pole');
        tokensInput.value = String(settings.maxTokens ?? 4096);
        tokensInput.addEventListener('input', () => {
            settings.maxTokens = Number(tokensInput.value) || 4096;
            this.saveSettings();
        });
        tokensLabel.append(tokensInput);
        block.append(tokensLabel);

        // Selection bubble toggle
        const bubbleLabel = document.createElement('label');
        bubbleLabel.classList.add('checkbox_label');
        const bubbleInput = document.createElement('input');
        bubbleInput.type = 'checkbox';
        bubbleInput.id = `${SETTINGS_PREFIX}-bubble`;
        bubbleInput.checked = settings.selectionBubble !== false;
        bubbleInput.addEventListener('change', () => {
            settings.selectionBubble = bubbleInput.checked;
            if (!bubbleInput.checked) this.hideBubble();
            this.saveSettings();
        });
        const bubbleText = document.createElement('span');
        bubbleText.textContent = t`Show floating translate button when text is selected`;
        bubbleLabel.append(bubbleInput, bubbleText);
        block.append(bubbleLabel);

        // Prompt presets
        const promptHeader = document.createElement('label');
        promptHeader.textContent = t`Translation prompt`;
        block.append(promptHeader);

        const presetRow = document.createElement('div');
        presetRow.classList.add('cct-translator-preset-row');

        const presetSelect = document.createElement('select');
        presetSelect.id = `${SETTINGS_PREFIX}-preset`;
        presetSelect.classList.add('text_pole');

        const promptArea = document.createElement('textarea');
        promptArea.classList.add('text_pole', 'cct-translator-prompt');
        promptArea.rows = 6;

        const refreshPresets = () => {
            this.ensurePromptList();
            presetSelect.innerHTML = '';
            for (const prompt of settings.prompts) {
                const option = document.createElement('option');
                option.value = prompt.id;
                option.textContent = prompt.name;
                option.selected = prompt.id === settings.activePromptId;
                presetSelect.append(option);
            }
            promptArea.value = this.getActivePrompt().text ?? '';
        };

        presetSelect.addEventListener('change', () => {
            settings.activePromptId = presetSelect.value;
            this.saveSettings();
            refreshPresets();
        });

        promptArea.addEventListener('input', () => {
            this.getActivePrompt().text = promptArea.value;
            this.saveSettings();
        });

        const iconButton = (iconClass, title, onClick) => {
            const btn = document.createElement('div');
            btn.classList.add('menu_button', 'menu_button_icon', 'fa-solid', iconClass);
            btn.title = title;
            btn.addEventListener('click', onClick);
            return btn;
        };

        const newBtn = iconButton('fa-plus', t`New prompt`, async () => {
            const name = await this.inputPopup(t`Prompt name`);
            if (!name || !name.trim()) return;
            const prompt = {
                id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
                name: name.trim(),
                text: promptArea.value || DEFAULT_TRANSLATE_PROMPT,
            };
            settings.prompts.push(prompt);
            settings.activePromptId = prompt.id;
            this.saveSettings();
            refreshPresets();
        });

        const renameBtn = iconButton('fa-pencil', t`Rename prompt`, async () => {
            const prompt = this.getActivePrompt();
            const name = await this.inputPopup(t`Prompt name`, prompt.name);
            if (!name || !name.trim()) return;
            prompt.name = name.trim();
            this.saveSettings();
            refreshPresets();
        });

        const deleteBtn = iconButton('fa-trash-can', t`Delete prompt`, async () => {
            if (settings.prompts.length <= 1) {
                toastr.warning(t`At least one prompt must remain.`);
                return;
            }
            const prompt = this.getActivePrompt();
            const ok = await this.confirmPopup(`${t`Delete prompt`}: ${prompt.name}?`);
            if (!ok) return;
            settings.prompts = settings.prompts.filter(p => p.id !== prompt.id);
            settings.activePromptId = settings.prompts[0].id;
            this.saveSettings();
            refreshPresets();
        });

        const resetBtn = iconButton('fa-rotate-left', t`Reset prompt text to default`, () => {
            this.getActivePrompt().text = DEFAULT_TRANSLATE_PROMPT;
            this.saveSettings();
            refreshPresets();
        });

        presetRow.append(presetSelect, newBtn, renameBtn, deleteBtn, resetBtn);
        block.append(presetRow, promptArea);

        const placeholders = document.createElement('small');
        placeholders.classList.add('cct-translator-hint');
        placeholders.textContent = t`Placeholders: {{language}} = target language, {{name}} = speaker, {{text}} = text to translate (if omitted, the text is sent as a separate user message).`;
        block.append(placeholders);

        refreshPresets();
        container.append(block);
    }

    populateProfiles(select, selectedId) {
        const service = SillyTavern.getContext().ConnectionManagerRequestService;
        const profiles = service?.getSupportedProfiles?.() ?? [];

        select.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = t`-- Select profile --`;
        select.append(none);

        for (const profile of profiles) {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.model ? `${profile.name} (${profile.model})` : profile.name;
            option.selected = profile.id === selectedId;
            select.append(option);
        }
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

    destroy() {
        this.enabled = false;
        if (this.intervalId) clearInterval(this.intervalId);
        if (this.observer) this.observer.disconnect();
        clearTimeout(this.selectionTimer);
        document.removeEventListener('mousedown', this.handleMouseDown, true);
        document.removeEventListener('click', this.handleClick, true);
        document.removeEventListener('selectionchange', this.handleSelectionChange);
        window.removeEventListener('scroll', this.hideBubble, true);
        this.bubble?.remove();
        this.bubble = null;
        this.teardown();
    }
}
