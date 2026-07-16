const { EventEmitter } = require('events');
const { createWindowManager } = require('../desktop/window-manager');

class MockWindow extends EventEmitter {
    static instances = [];

    static getFocusedWindow() { return null; }
    static getAllWindows() { return MockWindow.instances.filter((win) => !win.destroyed); }

    constructor(options) {
        super();
        this.options = options;
        this.destroyed = false;
        this.visible = options.show !== false;
        this.minimized = false;
        this.webContents = new EventEmitter();
        this.webContents.send = () => {};
        MockWindow.instances.push(this);
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    getBounds() { return this.options; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    setMenuBarVisibility() {}
    setAlwaysOnTop(value, level) { this.alwaysOnTop = { value, level }; }
    setIgnoreMouseEvents(value) { this.ignoreMouseEvents = value; }
    setBounds(value) { this.bounds = value; }
    hide() { this.visible = false; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    focus() { this.focused = true; }
    restore() { this.minimized = false; this.visible = true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
}

class MockTray extends EventEmitter {
    static instances = [];

    constructor() {
        super();
        this.destroyed = false;
        MockTray.instances.push(this);
    }

    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    destroy() { this.destroyed = true; }
}

function setup() {
    MockWindow.instances = [];
    MockTray.instances = [];
    const handlers = {};
    const display = {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    const manager = createWindowManager({
        BrowserWindow: MockWindow,
        Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
        screen: { getPrimaryDisplay: () => display, getDisplayMatching: () => display },
        Tray: MockTray,
        nativeImage: { createFromBitmap: () => ({}) },
        ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
        appUrl: (pathname) => `fund-tracker://app/${pathname}`,
        isWindows: true,
        onClearAndQuit() {},
        preloadPath: 'preload.js',
    });
    manager.registerIpc();
    return { handlers, manager };
}

describe('Windows window manager', () => {
    it('keeps the original holding widget independent from the taskbar', () => {
        const { handlers } = setup();
        handlers['open-holding-window']();
        const holdingWindow = MockWindow.instances[0];
        expect(holdingWindow.options.skipTaskbar).toBe(true);
        expect(holdingWindow.options.focusable).toBe(false);
        expect(holdingWindow.url).not.toContain('mode=taskbar');
    });

    it('creates a separate compact ticker inside a bottom Windows taskbar', () => {
        const { handlers } = setup();
        expect(handlers['set-taskbar-ticker-enabled'](null, true)).toEqual({ ok: true, enabled: true });
        const ticker = MockWindow.instances[0];
        expect(ticker.url).toContain('mode=taskbar');
        expect(ticker.options).toMatchObject({ x: 1238, y: 1040, width: 260, height: 40, skipTaskbar: true, focusable: false, transparent: true });
        expect(ticker.alwaysOnTop).toEqual({ value: true, level: 'screen-saver' });
        expect(ticker.ignoreMouseEvents).toBe(true);

        handlers['set-taskbar-ticker-enabled'](null, false);
        expect(ticker.destroyed).toBe(true);
    });

    it('keeps the main window in the taskbar and adds a restorable tray icon when minimized', () => {
        const { manager } = setup();
        const mainWindow = manager.createMainWindow();
        mainWindow.minimized = true;
        mainWindow.emit('minimize');

        expect(mainWindow.destroyed).toBe(false);
        expect(MockTray.instances).toHaveLength(1);
        expect(MockTray.instances[0].tooltip).toBe('恭喜发财');

        MockTray.instances[0].emit('click');
        expect(mainWindow.minimized).toBe(false);
        expect(mainWindow.focused).toBe(true);
        expect(MockTray.instances[0].destroyed).toBe(true);
    });
});
