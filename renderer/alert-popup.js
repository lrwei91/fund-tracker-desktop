(function () {
    var alertElement = document.getElementById('alert');
    var mascot = document.getElementById('mascot');
    var title = document.getElementById('alert-title');
    var detail = document.getElementById('alert-detail');

    function price(value) {
        return typeof value === 'number' && value > 0 ? value.toFixed(2) : '--';
    }

    function showAlert(alert) {
        if (!alert || typeof alert.changePct !== 'number') return;
        var rising = alert.changePct >= 0;
        var sign = alert.changePct > 0 ? '+' : '';
        mascot.textContent = rising ? '🐂' : '🐻';
        title.textContent = String(alert.name || alert.code || '自选股') + (rising ? ' 上涨提醒' : ' 下跌提醒');
        detail.textContent = sign + alert.changePct.toFixed(2) + '%  ·  现价 ' + price(alert.price);
        alertElement.style.opacity = String(alert.opacity);
        alertElement.style.animation = 'none';
        void alertElement.offsetWidth;
        alertElement.style.animation = '';
        if (alert.soundEnabled) playAlertSound(rising);
    }

    function playAlertSound(rising) {
        var file = rising ? 'bull-moo.wav' : 'bear-growl.wav';
        var audio = new Audio('assets/' + file);
        audio.volume = 0.82;
        audio.play().catch(function () {});
    }

    if (window.shell && typeof window.shell.onStockAlert === 'function') {
        window.shell.onStockAlert(showAlert);
    }
})();
