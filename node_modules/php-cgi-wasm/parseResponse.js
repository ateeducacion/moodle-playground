"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.parseResponse = void 0;
var parseResponse = exports.parseResponse = function parseResponse(response) {
  var headers = new Headers();
  var line = [];
  var decoder = new TextDecoder();
  var i = 0;
  for (; i < response.length; i++) {
    if (response[i] === 0xD && response[i + 1] === 0xA)
      // We're at a CRLF
      {
        if (line.length) {
          var header = decoder.decode(new Uint8Array(line).buffer);
          var colon = header.indexOf(':');
          if (colon < 0) {
            headers.append(header, true);
          } else {
            headers.append(header.substring(0, colon), header.substring(colon + 2));
          }
          line.length = 0;
          i++;
          continue;
        } else {
          i++;
          break;
        }
      }
    line.push(response[i]);
  }
  return {
    headers: headers,
    body: new Uint8Array(response.slice(1 + i)).buffer
  };
};