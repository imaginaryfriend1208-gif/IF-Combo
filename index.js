/**
 * IF Combo extension for SillyTavern
 */

// Global settings and constants
const EXTENSION_NAME = 'IF Combo';
const settingsKey = 'ChatCompletionTabs';
const VERSION = "1.6.0";

// Import required functions
import { t } from '../../../i18n.js';

// Import components
import { OpenAITabManager } from './components/openai-tab-manager.js';
import { ContextLockManager } from './components/context-lock.js';
import { CompactParameterManager } from './components/compact-parameters.js';
import { StatusBarManager } from './components/status-bar.js';
import { PromptPickerManager } from './components/prompt-picker.js';
import { InputHistoryManager } from './components/input-history.js';
import { ImageReaderManager, DEFAULT_IMAGE_READER_PROMPT } from './components/image-reader.js';

/**
 * Default settings configuration
 */
const defaultSettings = {
    enabled: true,
    features: {
        tabs: true,
        contextLock: true,
        compactParameters: true,
        statusBar: true,
        promptPicker: true,
        inputHistory: true,
        imageReader: false,
    },
    contextLock: {
        enabled: false,
        size: 100000, // one of 100000/150000/180000/200000 or 'custom'
        customSize: 120000
    },
    imageReader: {
        profileId: null,
        prompt: DEFAULT_IMAGE_READER_PROMPT,
        maxTokens: 2048,
        hideImagesFromModel: true,
        template: '[Image description: {{description}}]'
    }
};

// Global tab manager instances
let openAITabManager = null;
let contextLockManager = null;
let compactParameterManager = null;
let statusBarManager = null;
let promptPickerManager = null;
let inputHistoryManager = null;
let imageReaderManager = null;

/**
 * Feature toggles shown in the settings drawer.
 * `apply` receives the effective enabled state (feature flag AND master switch).
 */
const FEATURES = [
    { key: 'tabs', label: () => t`Parameters / Prompts tabs`, apply: (on) => openAITabManager?.setEnabled(on) },
    { key: 'contextLock', label: () => t`Locked context size`, apply: (on) => contextLockManager?.setVisible(on) },
    { key: 'compactParameters', label: () => t`Compact parameter controls`, apply: (on) => compactParameterManager?.setEnabled(on) },
    { key: 'statusBar', label: () => t`Status bar`, apply: (on) => statusBarManager?.setEnabled(on) },
    { key: 'promptPicker', label: () => t`Prompt picker`, apply: (on) => promptPickerManager?.setEnabled(on) },
    { key: 'inputHistory', label: () => t`Input history`, apply: (on) => inputHistoryManager?.setEnabled(on) },
    { key: 'imageReader', label: () => t`Image reader`, apply: (on) => imageReaderManager?.setEnabled(on) },
];

function isFeatureEnabled(key) {
    const settings = SillyTavern.getContext().extensionSettings[settingsKey];
    return !!settings.enabled && settings.features?.[key] !== false;
}

function applyAllFeatures() {
    for (const feature of FEATURES) {
        feature.apply(isFeatureEnabled(feature.key));
    }
}

/**
 * Main extension initialization function
 */
(function initExtension() {
    // Get SillyTavern context
    const context = SillyTavern.getContext();

    // Initialize settings
    if (!context.extensionSettings[settingsKey]) {
        context.extensionSettings[settingsKey] = { ...defaultSettings };
    }

    // Ensure all default setting keys exist (one level deep for nested objects)
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (context.extensionSettings[settingsKey][key] === undefined) {
            context.extensionSettings[settingsKey][key] = structuredClone(value);
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [subKey, subValue] of Object.entries(value)) {
                if (context.extensionSettings[settingsKey][key][subKey] === undefined) {
                    context.extensionSettings[settingsKey][key][subKey] = structuredClone(subValue);
                }
            }
        }
    }

    // Save settings
    context.saveSettingsDebounced();

    // Initialize extension UI when DOM is fully loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initExtensionUI);
    } else {
        initExtensionUI();
    }
})();

/**
 * Initialize UI elements and events for the extension
 */
function initExtensionUI() {
    // Initialize managers first so the settings panel can render their controls
    initializeOpenAITabs();

    // Render extension settings
    renderExtensionSettings();
}

/**
 * Initialize OpenAI tab management
 */
function initializeOpenAITabs() {
    const context = SillyTavern.getContext();

    if (!openAITabManager) {
        openAITabManager = new OpenAITabManager();
    }

    if (!contextLockManager) {
        contextLockManager = new ContextLockManager({
            getSettings: () => context.extensionSettings[settingsKey].contextLock,
            saveSettings: () => context.saveSettingsDebounced(),
        });
    }

    if (!compactParameterManager) {
        compactParameterManager = new CompactParameterManager();
    }

    if (!statusBarManager) {
        statusBarManager = new StatusBarManager();
    }

    if (!promptPickerManager) {
        promptPickerManager = new PromptPickerManager();
    }

    if (!inputHistoryManager) {
        inputHistoryManager = new InputHistoryManager();
    }

    if (!imageReaderManager) {
        imageReaderManager = new ImageReaderManager({
            getSettings: () => context.extensionSettings[settingsKey].imageReader,
            saveSettings: () => context.saveSettingsDebounced(),
        });
    }

    applyAllFeatures();
}

/**
 * Render extension settings panel
 */
function renderExtensionSettings() {
    const context = SillyTavern.getContext();
    const settingsContainer = document.getElementById(`${settingsKey}-container`) ?? document.getElementById('extensions_settings2');
    if (!settingsContainer) {
        return;
    }

    // Find existing settings drawer to avoid duplication
    let existingDrawer = settingsContainer.querySelector(`#${settingsKey}-drawer`);
    if (existingDrawer) {
        return; // Don't recreate if exists
    }

    // Create settings drawer
    const inlineDrawer = document.createElement('div');
    inlineDrawer.id = `${settingsKey}-drawer`;
    inlineDrawer.classList.add('inline-drawer');
    settingsContainer.append(inlineDrawer);

    // Create drawer title
    const inlineDrawerToggle = document.createElement('div');
    inlineDrawerToggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');

    const extensionNameElement = document.createElement('b');
    extensionNameElement.textContent = EXTENSION_NAME;

    const versionBadge = document.createElement('span');
    versionBadge.classList.add('cct-version-badge');
    versionBadge.textContent = `v${VERSION}`;
    extensionNameElement.append(' ', versionBadge);

    const inlineDrawerIcon = document.createElement('div');
    inlineDrawerIcon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');

    inlineDrawerToggle.append(extensionNameElement, inlineDrawerIcon);

    // Create settings content area
    const inlineDrawerContent = document.createElement('div');
    inlineDrawerContent.classList.add('inline-drawer-content');

    // Add to drawer
    inlineDrawer.append(inlineDrawerToggle, inlineDrawerContent);

    // Get settings
    const settings = context.extensionSettings[settingsKey];

    // Per-feature toggle container (populated below, referenced by the master switch)
    const featureList = document.createElement('div');
    featureList.classList.add('cct-feature-list');
    featureList.classList.toggle('cct-features-disabled', !settings.enabled);

    // Create enable switch
    const enabledCheckboxLabel = document.createElement('label');
    enabledCheckboxLabel.classList.add('checkbox_label');
    enabledCheckboxLabel.htmlFor = `${settingsKey}-enabled`;

    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.id = `${settingsKey}-enabled`;
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = settings.enabled;

    enabledCheckbox.addEventListener('change', () => {
        settings.enabled = enabledCheckbox.checked;
        applyAllFeatures();
        featureList.classList.toggle('cct-features-disabled', !settings.enabled);
        context.saveSettingsDebounced();
    });

    const enabledCheckboxText = document.createElement('span');
    enabledCheckboxText.textContent = t`Enable IF Combo`;

    enabledCheckboxLabel.append(enabledCheckbox, enabledCheckboxText);
    inlineDrawerContent.append(enabledCheckboxLabel);

    // Per-feature toggles
    for (const feature of FEATURES) {
        const label = document.createElement('label');
        label.classList.add('checkbox_label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `${settingsKey}-feature-${feature.key}`;
        checkbox.checked = settings.features[feature.key] !== false;
        const text = document.createElement('span');
        text.textContent = feature.label();
        label.append(checkbox, text);
        featureList.append(label);

        // Image Reader settings panel, shown only while the feature is ticked
        let subPanel = null;
        if (feature.key === 'imageReader' && imageReaderManager) {
            subPanel = document.createElement('div');
            subPanel.classList.add('cct-feature-panel');
            subPanel.hidden = !checkbox.checked;
            imageReaderManager.renderSettings(subPanel);
            featureList.append(subPanel);
        }

        checkbox.addEventListener('change', () => {
            settings.features[feature.key] = checkbox.checked;
            feature.apply(isFeatureEnabled(feature.key));
            if (subPanel) subPanel.hidden = !checkbox.checked;
            context.saveSettingsDebounced();
        });
    }
    inlineDrawerContent.append(featureList);

    // Contact / support links
    const linksRow = document.createElement('div');
    linksRow.classList.add('cct-links-row');

    const discordLink = document.createElement('a');
    discordLink.classList.add('menu_button', 'cct-link-button');
    discordLink.href = 'https://discord.com/users/1148686772281278585';
    discordLink.target = '_blank';
    discordLink.rel = 'noopener noreferrer';
    discordLink.title = t`Contact me on Discord`;
    const discordIcon = document.createElement('i');
    discordIcon.classList.add('fa-brands', 'fa-discord');
    const discordText = document.createElement('span');
    discordText.textContent = t`Contact me`;
    discordLink.append(discordIcon, discordText);

    const kofiLink = document.createElement('a');
    kofiLink.classList.add('menu_button', 'cct-link-button');
    kofiLink.href = 'https://ko-fi.com/holimo';
    kofiLink.target = '_blank';
    kofiLink.rel = 'noopener noreferrer';
    kofiLink.title = t`Support me on Ko-fi`;
    const kofiIcon = document.createElement('i');
    kofiIcon.classList.add('fa-solid', 'fa-mug-hot');
    const kofiText = document.createElement('span');
    kofiText.textContent = t`Support me`;
    kofiLink.append(kofiIcon, kofiText);

    linksRow.append(discordLink, kofiLink);
    inlineDrawerContent.append(linksRow);

    // Initialize drawer toggle functionality
    inlineDrawerToggle.addEventListener('click', function() {
        this.classList.toggle('open');
        inlineDrawerIcon.classList.toggle('down');
        inlineDrawerIcon.classList.toggle('up');
        inlineDrawerContent.classList.toggle('open');
    });
}
// Additional initialization calls with delays to ensure proper loading
setTimeout(() => {
    if (openAITabManager) {
        openAITabManager.refreshTabs();
    }
}, 1000);

setTimeout(() => {
    if (openAITabManager) {
        openAITabManager.refreshTabs();
    }
}, 3000);

// Export for debugging purposes
window.ChatCompletionTabs = {
    get openAITabManager() { return openAITabManager; },
    get contextLockManager() { return contextLockManager; },
    get compactParameterManager() { return compactParameterManager; },
    get statusBarManager() { return statusBarManager; },
    get promptPickerManager() { return promptPickerManager; },
    get inputHistoryManager() { return inputHistoryManager; },
    get imageReaderManager() { return imageReaderManager; },
    VERSION
};
