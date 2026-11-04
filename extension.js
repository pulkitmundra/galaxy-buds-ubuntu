import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BudsIndicator} from './budsQuickToggle.js';

export default class BudsQuickToggleExtension extends Extension {
    enable() {
        this._indicator = new BudsIndicator(this);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
