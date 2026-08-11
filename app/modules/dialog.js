// Shared modal behavior: Escape, focus trap, background inert and focus return.
(function () {
    var activeDialogs = new Set();
    var records = new WeakMap();

    function appShell() {
        return document.getElementById('app-shell') || document.querySelector('.app-shell');
    }

    function focusable(panel) {
        return Array.from(panel.querySelectorAll([
            'a[href]', 'button:not([disabled])', 'input:not([disabled])',
            'select:not([disabled])', 'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(','))).filter(function (element) {
            return !element.hidden && element.getAttribute('aria-hidden') !== 'true';
        });
    }

    function syncBackground() {
        var shell = appShell();
        var blocked = activeDialogs.size > 0;
        if (shell) shell.inert = blocked;
        document.body.classList.toggle('dialog-open', blocked);
    }

    function close(panel) {
        var record = records.get(panel);
        if (!record) return;
        panel.removeEventListener('keydown', record.onKeyDown);
        if (record.openClass) {
            panel.classList.remove(record.openClass);
            if (record.overlay) record.overlay.classList.remove(record.openClass);
        }
        if (record.hideOnClose) {
            panel.hidden = true;
            if (record.overlay) record.overlay.hidden = true;
        }
        activeDialogs.delete(panel);
        records.delete(panel);
        syncBackground();
        var returnTarget = record.trigger;
        if ((!returnTarget || !returnTarget.isConnected) && typeof record.restoreFocus === 'function') {
            returnTarget = record.restoreFocus();
        }
        if (returnTarget && returnTarget.isConnected && typeof returnTarget.focus === 'function') {
            returnTarget.focus();
        }
        if (typeof record.onClose === 'function') record.onClose();
    }

    function open(panel, overlay, options) {
        if (!panel) return;
        options = options || {};
        if (records.has(panel)) return;
        var record = {
            hideOnClose: !!options.hideOnClose,
            onClose: options.onClose,
            openClass: options.openClass || '',
            overlay: overlay || null,
            restoreFocus: options.restoreFocus,
            trigger: options.trigger || document.activeElement,
        };
        record.onKeyDown = function (event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                close(panel);
                return;
            }
            if (event.key !== 'Tab') return;
            var items = focusable(panel);
            if (!items.length) {
                event.preventDefault();
                panel.focus();
                return;
            }
            var first = items[0];
            var last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        records.set(panel, record);
        activeDialogs.add(panel);
        if (record.hideOnClose) {
            panel.hidden = false;
            if (record.overlay) record.overlay.hidden = false;
        }
        if (record.openClass) {
            panel.classList.add(record.openClass);
            if (record.overlay) record.overlay.classList.add(record.openClass);
        }
        panel.addEventListener('keydown', record.onKeyDown);
        syncBackground();
        var target = options.focusTarget || focusable(panel)[0] || panel;
        if (!target.hasAttribute('tabindex') && target === panel) target.tabIndex = -1;
        target.focus();
    }

    window.AppDialog = { close: close, open: open };
})();
