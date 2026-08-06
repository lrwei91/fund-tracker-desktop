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
        this.webContents.sent = [];
        this.webContents.send = (channel, payload) => { this.webContents.sent.push({ channel, payload }); };
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
    it('creates the holding widget as an independent window', () => {
        const { handlers } = setup();
        handlers['open-holding-window']();
        const holdingWindow = MockWindow.instances[0];
        expect(holdingWindow.options.skipTaskbar).toBe(true);
        expect(holdingWindow.options.focusable).toBe(false);
        expect(holdingWindow.url).toContain('renderer/holding-widget.html');
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

    it('shows stock alerts in a separate always-on-top window without stealing focus', () => {
        const { handlers } = setup();
        const result = handlers['show-stock-alert'](null, {
            code: '600000', name: '浦发银行', price: 10.5, changePct: 2.3,
            basePrice: 10.26, baseLabel: '开盘价', threshold: 2, opacity: 0.8,
            soundEnabled: false, time: new Date().toISOString(),
        });
        expect(result).toEqual({ ok: true });

        const alertWindow = MockWindow.instances[0];
        expect(alertWindow.url).toContain('renderer/alert-popup.html');
        expect(alertWindow.options).toMatchObject({ frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false });
        expect(alertWindow.alwaysOnTop).toEqual({ value: true, level: 'screen-saver' });
        expect(alertWindow.ignoreMouseEvents).toBe(true);

        alertWindow.webContents.emit('did-finish-load');
        expect(alertWindow.visible).toBe(true);
        expect(alertWindow.focused).not.toBe(true);
        expect(alertWindow.webContents.sent[0]).toMatchObject({
            channel: 'stock-alert',
            payload: { code: '600000', name: '浦发银行', opacity: 0.8, soundEnabled: false },
        });
    });

    it('rejects invalid stock alert payloads', () => {
        const { handlers } = setup();
        expect(handlers['show-stock-alert'](null, { price: 0, changePct: 'bad' })).toEqual({
            ok: false,
            error: 'Invalid alert payload',
        });
        expect(MockWindow.instances).toHaveLength(0);
    });
});
