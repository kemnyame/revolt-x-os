(function () {
    'use strict';
    if (window.top !== window) return;
    if (window.__rxNativeCleanup) window.__rxNativeCleanup();
    var port = null, busy = false;
    // The native side replaces this unpredictable token for every navigation.
    function onPort(event) {
        if (event.data !== '__RX_CHANNEL_TOKEN__' || !event.ports || event.ports.length !== 1) return;
        port = event.ports[0];
        port.start();
    }
    window.addEventListener('message', onPort);
    function send(message) { if (port) port.postMessage(JSON.stringify(message)); }
    async function download(url, name) {
        if (!port || busy) return;
        busy = true;
        try {
            var response = await fetch(url, {credentials: 'same-origin'});
            if (!response.ok) throw Error('The download could not be loaded.');
            var blob = await response.blob();
            if (blob.size > 16 * 1024 * 1024) throw Error('This file is too large. Open the app menu and use Open in browser.');
            var encoded = await new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            send({type: 'download_start', name: name || 'school-document', mime: blob.type || 'application/octet-stream', size: blob.size});
            for (var i = 0; i < encoded.length; i += 32768) send({type: 'download_chunk', data: encoded.slice(i, i + 32768)});
            send({type: 'download_end'});
        } catch (error) { window.alert(error.message || 'The download could not be saved.'); }
        finally { busy = false; }
    }
    // Capture generated report PDFs and spreadsheet exports before their blob URL is revoked.
    function onDownload(event) {
        var anchor = event.target.closest && event.target.closest('a[download]');
        if (!anchor || !port) return;
        var url = new URL(anchor.href, location.href);
        if (!anchor.href.startsWith('blob:') && url.origin !== location.origin) return;
        event.preventDefault();
        download(anchor.href, anchor.download);
    }
    document.addEventListener('click', onDownload, true);
    var originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (port && this.download && this.href.startsWith('blob:')) download(this.href, this.download);
        else originalClick.call(this);
    };
    window.__rxNativeCleanup = function () {
        window.removeEventListener('message', onPort);
        document.removeEventListener('click', onDownload, true);
        HTMLAnchorElement.prototype.click = originalClick;
        if (port) port.close();
    };
    window.print = function () { send({type: 'print'}); };
})();
