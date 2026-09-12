/**
 * Compact OpenAI Parameter Manager
 * Reduces the vertical space used by the four commonly visible sampling
 * controls without replacing SillyTavern's native inputs or event handlers.
 */

const PARAMETER_IDS = [
    'temp_openai',
    'freq_pen_openai',
    'pres_pen_openai',
    'top_p_openai',
];

export class CompactParameterManager {
    constructor() {
        this.enabled = true;
        this.intervalId = null;
        this.init();
    }

    init() {
        setTimeout(() => this.apply(), 300);
        this.intervalId = setInterval(() => this.apply(), 2000);
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (enabled) {
            this.apply();
        } else {
            this.teardown();
        }
    }

    apply() {
        if (!this.enabled) return;

        for (const id of PARAMETER_IDS) {
            const input = document.getElementById(id);
            const block = input?.closest('.range-block');
            if (!block) continue;

            block.classList.add('cct-compact-parameter');
            block.dataset.cctParameter = id;
        }
    }

    teardown() {
        document.querySelectorAll('.cct-compact-parameter').forEach((block) => {
            block.classList.remove('cct-compact-parameter');
            delete block.dataset.cctParameter;
        });
    }

    destroy() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.teardown();
    }
}
