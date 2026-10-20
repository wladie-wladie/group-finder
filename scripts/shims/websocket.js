// GramJS uses the "websocket" package's W3C client; in a WebView that is the built-in WebSocket.
exports.w3cwebsocket = function (url, protocols) { return new globalThis.WebSocket(url, protocols); };
