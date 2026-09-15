/**
 * Image Reader
 * Describes every image the user uploads with a vision model taken from a
 * saved Connection Manager profile, then attaches the description to the
 * message so the main model receives text instead of (or alongside) the image.
 */

import { t } from '../../../../i18n.js';

const SETTINGS_PREFIX = 'cct-image-reader';
const DESCRIBED_FLAG = 'ifComboDescribed';

export const DEFAULT_IMAGE_READER_PROMPT = [
    'You are an image transcription engine. Describe the attached image in exhaustive detail so that a reader who cannot see it can reconstruct it mentally.',
    'Cover: every person/creature (count, apparent age, gender, body type, skin/hair/eye color, hairstyle, facial expression, gaze, pose, gestures), clothing and accessories (colors, fabric, fit, condition), every object and its placement, setting/background, time of day, weather, lighting direction and quality, color palette, camera angle and framing, art style or medium, image quality, mood and implied action or narrative.',
    'Transcribe verbatim any visible text, signs, UI elements, subtitles or logos.',
    'Do not speculate about identity of real people. Do not add commentary, disclaimers or moral judgement. Output only the description in plain prose, structured by region if helpful.',
].join('\n');

export class ImageReaderManager {
    /**
     * @param {object} options
     * @param {() => object} options.getSettings - returns imageReader settings { profileId, prompt, maxTokens, hideImagesFromModel, template }
     * @param {() => void} options.saveSettings - persists settings
     */
    constructor({ getSettings, saveSettings }) {
        this.getSettings = getSettings;
        this.saveSettings = saveSettings;
        this.enabled = true;
        this.inFlight = new Set();
        this.eventBindings = [];

        this.handleMessageEvent = this.handleMessageEvent.bind(this);
        this.handlePromptReady = this.handlePromptReady.bind(this);

        this.bindEvents();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
    }

    isActive() {
        return this.enabled;
    }

    bindEvents() {
        try {
            const { eventSource, eventTypes } = SillyTavern.getContext();
            if (!eventSource || !eventTypes) return;
            const bind = (type, handler) => {
                if (!type) return;
                eventSource.on(type, handler);
                this.eventBindings.push({ eventSource, type, handler });
            };
            bind(eventTypes.MESSAGE_SENT, this.handleMessageEvent);
            bind(eventTypes.MESSAGE_FILE_EMBEDDED, this.handleMessageEvent);
            bind(eventTypes.CHAT_COMPLETION_PROMPT_READY, this.handlePromptReady);
        } catch (error) {
            console.warn('[IF Combo] Image reader could not bind events', error);
        }
    }

    // ---------------------------------------------------------------- core

    /**
     * Runs when a user message is sent or a file is embedded into a message.
     * @param {number} messageId
     */
    async handleMessageEvent(messageId) {
        if (!this.isActive()) return;

        const context = SillyTavern.getContext();
        const message = context.chat?.[messageId];
        if (!message || !message.is_user) return;
        if (!Array.isArray(message.extra?.media) || message.extra.media.length === 0) return;

        const settings = this.getSettings();
        if (!settings.profileId) {
            toastr.warning(t`Image Reader: no connection profile selected.`);
            return;
        }

        let changed = false;
        for (let index = 0; index < message.extra.media.length; index++) {
            const media = message.extra.media[index];
            if (!media?.url) continue;
            if ((media.type ?? 'image') !== 'image') continue;
            if (media[DESCRIBED_FLAG]) continue;
            // Only user uploads; skip generated / API images.
            if (media.source && media.source !== 'upload') continue;

            const key = `${messageId}:${index}:${media.url}`;
            if (this.inFlight.has(key)) continue;
            this.inFlight.add(key);

            try {
                toastr.info(t`Describing image...`, 'IF Combo', { timeOut: 2000 });
                const description = await this.describeImage(media.url);
                if (!description) continue;

                media.title = this.wrapTemplate(description);
                media.append_title = true;
                media.captioned = true;
                media[DESCRIBED_FLAG] = true;
                changed = true;
            } catch (error) {
                console.error('[IF Combo] Image description failed', error);
                toastr.error(String(error?.cause?.message || error?.message || error), t`Image Reader failed`);
            } finally {
                this.inFlight.delete(key);
            }
        }

        if (changed) {
            try {
                context.updateMessageBlock?.(messageId, message);
            } catch {
                // Rendering refresh is best-effort.
            }
            await context.saveChat();
        }
    }

    /**
     * Strips raw image parts from the outgoing chat-completion prompt when
     * the user chose to send descriptions only.
     * @param {{ chat: any[], dryRun: boolean }} eventData
     */
    handlePromptReady(eventData) {
        if (!this.isActive() || eventData?.dryRun) return;
        if (!this.getSettings().hideImagesFromModel) return;
        if (!Array.isArray(eventData?.chat)) return;

        for (const message of eventData.chat) {
            if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
            const kept = message.content.filter(part => part?.type !== 'image_url');
            if (kept.length === message.content.length) continue;
            message.content = kept.length === 1 && kept[0]?.type === 'text' ? kept[0].text : kept;
        }
    }

    /**
     * Sends the image to the vision model configured in the selected profile.
     * @param {string} url Image URL (relative ST path or data URL)
     * @returns {Promise<string>}
     */
    async describeImage(url) {
        const settings = this.getSettings();
        const context = SillyTavern.getContext();
        const service = context.ConnectionManagerRequestService;
        if (!service) throw new Error('Connection Manager is not available');

        const profile = service.getProfile(settings.profileId);
        if (!profile) throw new Error('Selected connection profile no longer exists');
        if (profile.api !== 'openai' && profile.mode !== 'cc') {
            // Text completion profiles cannot carry images.
            if (!['openai'].includes(profile.api) && !profile['api-url']?.includes('/v1')) {
                throw new Error('Image Reader requires a Chat Completion profile');
            }
        }

        const dataUrl = await this.toDataUrl(url);
        const prompt = String(settings.prompt || DEFAULT_IMAGE_READER_PROMPT);
        const maxTokens = Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : 2048;

        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                ],
            },
        ];

        const result = await service.sendRequest(
            settings.profileId,
            /** @type {any} */ (messages),
            maxTokens,
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
        );

        const text = typeof result === 'string' ? result : result?.content;
        return String(text ?? '').trim();
    }

    async toDataUrl(url) {
        if (/^data:/i.test(url)) return url;
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('Failed to read image'));
            reader.readAsDataURL(blob);
        });
    }

    wrapTemplate(description) {
        const template = String(this.getSettings().template || '[Image description: {{description}}]');
        return template.replace(/{{description}}/gi, description);
    }

    // ------------------------------------------------------------ settings UI

    /**
     * Renders the Image Reader controls into the IF Combo settings drawer.
     * @param {HTMLElement} container
     */
    renderSettings(container) {
        if (!container || container.querySelector(`#${SETTINGS_PREFIX}-block`)) return;
        const settings = this.getSettings();

        const block = document.createElement('div');
        block.id = `${SETTINGS_PREFIX}-block`;
        block.classList.add('cct-image-reader-block');

        const hint = document.createElement('small');
        hint.classList.add('cct-image-reader-hint');
        hint.textContent = t`Describes every uploaded image with a vision model from a saved connection profile and appends the description to the message.`;
        block.append(hint);

        block.append(this.buildCheckbox('hideImagesFromModel', t`Send description only (do not send raw image to main model)`, settings));

        // Profile dropdown
        const profileLabel = document.createElement('label');
        profileLabel.textContent = t`Vision connection profile`;
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

        // Max tokens
        const tokensLabel = document.createElement('label');
        tokensLabel.textContent = t`Max description tokens`;
        const tokensInput = document.createElement('input');
        tokensInput.type = 'number';
        tokensInput.min = '64';
        tokensInput.step = '64';
        tokensInput.classList.add('text_pole');
        tokensInput.value = String(settings.maxTokens ?? 2048);
        tokensInput.addEventListener('input', () => {
            settings.maxTokens = Number(tokensInput.value) || 2048;
            this.saveSettings();
        });
        tokensLabel.append(tokensInput);
        block.append(tokensLabel);

        // Template
        const templateLabel = document.createElement('label');
        templateLabel.textContent = t`Injection template ({{description}})`;
        const templateInput = document.createElement('input');
        templateInput.type = 'text';
        templateInput.classList.add('text_pole');
        templateInput.value = String(settings.template ?? '');
        templateInput.addEventListener('input', () => {
            settings.template = templateInput.value;
            this.saveSettings();
        });
        templateLabel.append(templateInput);
        block.append(templateLabel);

        // Prompt
        const promptLabel = document.createElement('label');
        promptLabel.textContent = t`Description prompt`;
        const promptArea = document.createElement('textarea');
        promptArea.classList.add('text_pole', 'cct-image-reader-prompt');
        promptArea.rows = 6;
        promptArea.value = String(settings.prompt ?? '');
        promptArea.addEventListener('input', () => {
            settings.prompt = promptArea.value;
            this.saveSettings();
        });
        promptLabel.append(promptArea);
        block.append(promptLabel);

        const resetButton = document.createElement('div');
        resetButton.classList.add('menu_button', 'cct-image-reader-reset');
        resetButton.textContent = t`Reset prompt`;
        resetButton.addEventListener('click', () => {
            settings.prompt = DEFAULT_IMAGE_READER_PROMPT;
            promptArea.value = DEFAULT_IMAGE_READER_PROMPT;
            this.saveSettings();
        });
        block.append(resetButton);

        container.append(block);
    }

    buildCheckbox(key, text, settings) {
        const label = document.createElement('label');
        label.classList.add('checkbox_label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `${SETTINGS_PREFIX}-${key}`;
        input.checked = !!settings[key];
        input.addEventListener('change', () => {
            settings[key] = input.checked;
            this.saveSettings();
        });
        const span = document.createElement('span');
        span.textContent = text;
        label.append(input, span);
        return label;
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
            // Images require Chat Completion.
            if (profile.mode && profile.mode !== 'cc') continue;
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.model ? `${profile.name} (${profile.model})` : profile.name;
            option.selected = profile.id === selectedId;
            select.append(option);
        }
    }

    destroy() {
        for (const { eventSource, type, handler } of this.eventBindings) {
            eventSource.removeListener?.(type, handler);
        }
        this.eventBindings = [];
    }
}
