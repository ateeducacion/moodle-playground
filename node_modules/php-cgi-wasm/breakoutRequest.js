"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.breakoutRequest = void 0;
function _toConsumableArray(r) { return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _iterableToArray(r) { if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r); }
function _arrayWithoutHoles(r) { if (Array.isArray(r)) return _arrayLikeToArray(r); }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
var breakoutRequest = exports.breakoutRequest = function breakoutRequest(request) {
  var getPost = Promise.resolve('');
  if (request.body) {
    getPost = new Promise(function (accept) {
      var reader = request.body.getReader();
      var postBody = [];
      var _processBody = function processBody(_ref) {
        var done = _ref.done,
          value = _ref.value;
        if (value) {
          postBody.push(_toConsumableArray(value).map(function (x) {
            return String.fromCharCode(x);
          }).join(''));
        }
        if (!done) {
          return reader.read().then(_processBody);
        }
        accept(postBody.join(''));
      };
      return reader.read().then(_processBody);
    });
  } else if (request.arrayBuffer) {
    getPost = request.arrayBuffer().then(function (buffer) {
      return _toConsumableArray(new Uint8Array(buffer)).map(function (x) {
        return String.fromCharCode(x);
      }).join('');
    });
  } else if (request.on) {
    getPost = new Promise(function (accept) {
      var body = [];
      request.on('data', function (chunk) {
        return body.push(chunk);
      });
      request.on('end', function () {
        return accept(_toConsumableArray(new Uint8Array(Buffer.concat(body))).map(function (x) {
          return String.fromCharCode(x);
        }).join(''));
      });
    });
  }
  var url = new URL(request.url);
  return getPost.then(function (post) {
    return {
      url: url,
      method: request.method,
      get: url.search ? url.search.substr(1) : '',
      post: request.method === 'POST' ? post : null,
      contentType: request.method === 'POST' ? request.headers && request.headers.get('Content-Type') || 'application/x-www-form-urlencoded' : null
    };
  });
};