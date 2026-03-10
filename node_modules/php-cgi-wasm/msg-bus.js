"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.sendMessageFor = exports.onMessage = void 0;
function _slicedToArray(r, e) { return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t["return"] && (u = t["return"](), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(r) { if (Array.isArray(r)) return r; }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
var incomplete = new Map();

/**
 * Create a sendMessage function given a service worker URL.
 * @param {*} serviceWorkerUrl The URL to the service worker.
 * @returns sendMessage function for the service workrer.
 */
var sendMessageFor = exports.sendMessageFor = function sendMessageFor(serviceWorkerUrl) {
  return /*#__PURE__*/function () {
    var _ref = _asyncToGenerator(function* (action) {
      var params = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
      var token = window.crypto.randomUUID();
      var accept, reject;
      var ret = new Promise(function (_accept, _reject) {
        var _ref2;
        return _ref2 = [_accept, _reject], accept = _ref2[0], reject = _ref2[1], _ref2;
      });
      incomplete.set(token, [accept, reject, action, params]);
      navigator.serviceWorker.getRegistration(serviceWorkerUrl).then(function (registration) {
        return registration.active.postMessage({
          action: action,
          params: params,
          token: token
        });
      });
      return ret;
    });
    return function (_x) {
      return _ref.apply(this, arguments);
    };
  }();
};

/**
 * Event handler for recieved messages.
 * @param {*} event
 */
var onMessage = exports.onMessage = function onMessage(event) {
  if (event.data.re && incomplete.has(event.data.re)) {
    var _incomplete$get = incomplete.get(event.data.re),
      _incomplete$get2 = _slicedToArray(_incomplete$get, 4),
      accept = _incomplete$get2[0],
      reject = _incomplete$get2[1],
      action = _incomplete$get2[2],
      params = _incomplete$get2[3];
    incomplete["delete"](event.data.re);
    if (!event.data.error) {
      accept(event.data.result);
    } else {
      reject({
        error: event.data.error,
        action: action,
        params: params
      });
    }
  }
};