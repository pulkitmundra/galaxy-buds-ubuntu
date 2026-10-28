import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { BudsIndicator } from './budsQuickToggle.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

export default class BudsQuickToggleExtension extends Extension {
    enable() {
        if (!QuickSettingsMenu._budsIndicatorActive) {
            this._budsIndicator = new BudsIndicator();
            QuickSettingsMenu._budsIndicatorActive = this._budsIndicator;
        }
    }

    disable() {
        if (this._budsIndicator) {
            this._budsIndicator.destroy();
            this._budsIndicator = null;
            QuickSettingsMenu._budsIndicatorActive = null;
        }
    }
}
