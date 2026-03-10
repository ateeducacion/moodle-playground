"use strict";

function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.PhpCgiNode = void 0;
var _PhpCgiBase2 = require("./PhpCgiBase");
var _phpCgiNode = _interopRequireDefault(require("./php-cgi-node"));
var _nodePath = _interopRequireDefault(require("node:path"));
var _nodeUrl = _interopRequireDefault(require("node:url"));
var _nodeFs = _interopRequireDefault(require("node:fs"));
var _excluded = ["docroot", "prefix", "rewrite", "cookies", "types", "onRequest", "notFound"];
function _interopRequireDefault(e) { return e && e.__esModule ? e : { "default": e }; }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _objectWithoutProperties(e, t) { if (null == e) return {}; var o, r, i = _objectWithoutPropertiesLoose(e, t); if (Object.getOwnPropertySymbols) { var s = Object.getOwnPropertySymbols(e); for (r = 0; r < s.length; r++) o = s[r], t.includes(o) || {}.propertyIsEnumerable.call(e, o) && (i[o] = e[o]); } return i; }
function _objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (e.includes(n)) continue; t[n] = r[n]; } return t; }
function _classCallCheck(a, n) { if (!(a instanceof n)) throw new TypeError("Cannot call a class as a function"); }
function _defineProperties(e, r) { for (var t = 0; t < r.length; t++) { var o = r[t]; o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, _toPropertyKey(o.key), o); } }
function _createClass(e, r, t) { return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", { writable: !1 }), e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _callSuper(t, o, e) { return o = _getPrototypeOf(o), _possibleConstructorReturn(t, _isNativeReflectConstruct() ? Reflect.construct(o, e || [], _getPrototypeOf(t).constructor) : o.apply(t, e)); }
function _possibleConstructorReturn(t, e) { if (e && ("object" == _typeof(e) || "function" == typeof e)) return e; if (void 0 !== e) throw new TypeError("Derived constructors may only return object or undefined"); return _assertThisInitialized(t); }
function _assertThisInitialized(e) { if (void 0 === e) throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); return e; }
function _isNativeReflectConstruct() { try { var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {})); } catch (t) {} return (_isNativeReflectConstruct = function _isNativeReflectConstruct() { return !!t; })(); }
function _superPropGet(t, e, o, r) { var p = _get(_getPrototypeOf(1 & r ? t.prototype : t), e, o); return 2 & r && "function" == typeof p ? function (t) { return p.apply(o, t); } : p; }
function _get() { return _get = "undefined" != typeof Reflect && Reflect.get ? Reflect.get.bind() : function (e, t, r) { var p = _superPropBase(e, t); if (p) { var n = Object.getOwnPropertyDescriptor(p, t); return n.get ? n.get.call(arguments.length < 3 ? e : r) : n.value; } }, _get.apply(null, arguments); }
function _superPropBase(t, o) { for (; !{}.hasOwnProperty.call(t, o) && null !== (t = _getPrototypeOf(t));); return t; }
function _getPrototypeOf(t) { return _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function (t) { return t.__proto__ || Object.getPrototypeOf(t); }, _getPrototypeOf(t); }
function _inherits(t, e) { if ("function" != typeof e && null !== e) throw new TypeError("Super expression must either be null or a function"); t.prototype = Object.create(e && e.prototype, { constructor: { value: t, writable: !0, configurable: !0 } }), Object.defineProperty(t, "prototype", { writable: !1 }), e && _setPrototypeOf(t, e); }
function _setPrototypeOf(t, e) { return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) { return t.__proto__ = e, t; }, _setPrototypeOf(t, e); }
var PhpCgiNode = exports.PhpCgiNode = /*#__PURE__*/function (_PhpCgiBase) {
  function PhpCgiNode() {
    var _ref = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
      docroot = _ref.docroot,
      prefix = _ref.prefix,
      rewrite = _ref.rewrite,
      cookies = _ref.cookies,
      types = _ref.types,
      onRequest = _ref.onRequest,
      notFound = _ref.notFound,
      args = _objectWithoutProperties(_ref, _excluded);
    _classCallCheck(this, PhpCgiNode);
    var locateFile = function locateFile(name, dir) {
      if (name.substr(0, 7) === 'file://') {
        name = new URL(name).pathname;
      }
      if (dir === '') {
        if (typeof __dirname === 'undefined') {
          dir = _nodePath["default"].dirname(_nodeUrl["default"].fileURLToPath((undefined /*import.meta*/).url));
        } else {
          dir = __dirname;
        }
      }
      var located = _nodePath["default"].resolve(_nodePath["default"].format({
        dir: dir,
        name: name
      }));
      if (_nodeFs["default"].existsSync(located)) {
        return located;
      }
    };
    return _callSuper(this, PhpCgiNode, [_phpCgiNode["default"], _objectSpread({
      docroot: docroot,
      prefix: prefix,
      rewrite: rewrite,
      cookies: cookies,
      types: types,
      onRequest: onRequest,
      notFound: notFound,
      locateFile: locateFile
    }, args)]);
  }
  _inherits(PhpCgiNode, _PhpCgiBase);
  return _createClass(PhpCgiNode, [{
    key: "request",
    value: function () {
      var _request2 = _asyncToGenerator(function* (_request) {
        var protocol = _request.connection.encrypted ? 'https://' : 'http://';
        _request.url = new URL(protocol + _request.headers.host + _request.url);
        _request.headers = new Map(Object.entries(_request.headers));
        var response = yield _superPropGet(PhpCgiNode, "request", this, 3)([_request]);
        console.error("[".concat(new Date().toLocaleString(), "] [HTTP ").concat(response.status, "] ").concat(String(_request.method).padStart(5, ' '), " ").concat(_request.url));
        return response;
      });
      function request(_x) {
        return _request2.apply(this, arguments);
      }
      return request;
    }()
  }]);
}(_PhpCgiBase2.PhpCgiBase);