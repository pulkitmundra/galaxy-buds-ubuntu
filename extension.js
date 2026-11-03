import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { BudsIndicator } from './budsQuickToggle.js';

export default class BudsQuickToggleExtension extends Extension {
    enable() {
        const quickSettings = Main.panel.statusArea.quickSettings;
        if (quickSettings && !quickSettings._budsIndicatorActive) {
            this._budsIndicator = new BudsIndicator(this);
            quickSettings._budsIndicatorActive = this._budsIndicator;
        }
    }

    disable() {
        const quickSettings = Main.panel.statusArea.quickSettings;
        if (this._budsIndicator) {
            this._budsIndicator.destroy();
            this._budsIndicator = null;
            if (quickSettings) {
                delete quickSettings._budsIndicatorActive;
            }
        }
    }
}
