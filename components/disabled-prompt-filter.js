/**
 * Disabled Prompt Filter
 * Adds a small toggle button to the Chat Completion prompt manager footer
 * that hides prompts whose toggle is switched off. Hiding is purely visual
 * (a class on the prompt manager container), so the prompt order and the
 * enabled/disabled state are never modified.
 */

import { t } from '../../../../i18n.js';

const CONTAINER_SELECTOR = '#completion_prompt_manager';
const FOOTER_SELECTOR = '.completion_prompt_manager_footer';
const DISABLED_PROMPT_SELECTOR = 'li.completion_prompt_manager_prompt_disabled';
const BUTTON_ID = 'cct-hide-disabled-prompts';
const ACTIVE_CLASS = 'cct-hide-disabled';

export class DisabledPromptFilterManager {
    /**
     * @param {object} options
     * @param {() => boolean} options.getHidden - returns whether disabled prompts are hidden
     * @param {(hidden: boolean) => void} options.setHidden - persists the new state
     */
    constructor({ getHidden, setHidden }) {
        this.getHidden = getHidden;
        this.setHidden = setHidden;

        this.enabled = true;
        this.observer = null;
        this.intervalId = null;
        this.mutating = false;

        this.init();
    }

    init() {
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
                // ST re-rendered the footer or list; restore the button and count
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

    apply() {
        if (!this.enabled) return;

        const container = document.querySelector(CONTAINER_SELECTOR);
        if (!container) return;

        const hidden = this.getHidden();
        container.classList.toggle(ACTIVE_CLASS, hidden);

        const footer = container.querySelector(FOOTER_SELECTOR);
        if (!footer) return;

        let button = document.getElementById(BUTTON_ID);
        if (!button) {
            this.mutating = true;
            try {
                button = document.createElement('a');
                button.id = BUTTON_ID;
                button.classList.add('menu_button', 'fa-solid', 'fa-fw');
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.setHidden(!this.getHidden());
                    this.apply();
                });

                // Place it next to the import/export buttons
                const anchor = footer.querySelector('#prompt-manager-export')
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

        this.updateButton(button, container, hidden);
    }

    updateButton(button, container, hidden) {
        const count = container.querySelectorAll(DISABLED_PROMPT_SELECTOR).length;

        button.classList.toggle('cct-active', hidden);
        button.classList.toggle('fa-eye-slash', hidden);
        button.classList.toggle('fa-eye', !hidden);

        const label = hidden ? t`Show disabled prompts` : t`Hide disabled prompts`;
        button.title = `${label} (${count})`;
    }

    /**
     * MutationObserver callbacks run as microtasks after our synchronous DOM
     * changes, so the flag must be cleared on a later macrotask.
     */
    endMutation() {
        setTimeout(() => { this.mutating = false; }, 0);
    }

    teardown() {
        document.querySelector(CONTAINER_SELECTOR)?.classList.remove(ACTIVE_CLASS);
        document.getElementById(BUTTON_ID)?.remove();
    }

    destroy() {
        this.enabled = false;
        if (this.intervalId) clearInterval(this.intervalId);
        if (this.observer) this.observer.disconnect();
        this.teardown();
    }
}
