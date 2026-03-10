"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.PhpCgiWebBase = void 0;
var _PhpCgiBase2 = require("./PhpCgiBase");
var _webTransactions = require("./webTransactions");
var _resolveDependencies2 = require("./resolveDependencies");
function _toConsumableArray(r) { return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArray(r) { if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r); }
function _arrayWithoutHoles(r) { if (Array.isArray(r)) return _arrayLikeToArray(r); }
function _slicedToArray(r, e) { return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t["return"] && (u = t["return"](), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(r) { if (Array.isArray(r)) return r; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
function _classCallCheck(a, n) { if (!(a instanceof n)) throw new TypeError("Cannot call a class as a function"); }
function _defineProperties(e, r) { for (var t = 0; t < r.length; t++) { var o = r[t]; o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, _toPropertyKey(o.key), o); } }
function _createClass(e, r, t) { return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", { writable: !1 }), e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _callSuper(t, o, e) { return o = _getPrototypeOf(o), _possibleConstructorReturn(t, _isNativeReflectConstruct() ? Reflect.construct(o, e || [], _getPrototypeOf(t).constructor) : o.apply(t, e)); }
function _possibleConstructorReturn(t, e) { if (e && ("object" == _typeof(e) || "function" == typeof e)) return e; if (void 0 !== e) throw new TypeError("Derived constructors may only return object or undefined"); return _assertThisInitialized(t); }
function _assertThisInitialized(e) { if (void 0 === e) throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); return e; }
function _isNativeReflectConstruct() { try { var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {})); } catch (t) {} return (_isNativeReflectConstruct = function _isNativeReflectConstruct() { return !!t; })(); }
function _getPrototypeOf(t) { return _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function (t) { return t.__proto__ || Object.getPrototypeOf(t); }, _getPrototypeOf(t); }
function _inherits(t, e) { if ("function" != typeof e && null !== e) throw new TypeError("Super expression must either be null or a function"); t.prototype = Object.create(e && e.prototype, { constructor: { value: t, writable: !0, configurable: !0 } }), Object.defineProperty(t, "prototype", { writable: !1 }), e && _setPrototypeOf(t, e); }
function _setPrototypeOf(t, e) { return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) { return t.__proto__ = e, t; }, _setPrototypeOf(t, e); }
var STR = 'string';
var NUM = 'number';
var PhpCgiWebBase = exports.PhpCgiWebBase = /*#__PURE__*/function (_PhpCgiBase) {
  function PhpCgiWebBase() {
    _classCallCheck(this, PhpCgiWebBase);
    return _callSuper(this, PhpCgiWebBase, arguments);
  }
  _inherits(PhpCgiWebBase, _PhpCgiBase);
  return _createClass(PhpCgiWebBase, [{
    key: "startTransaction",
    value: function startTransaction() {
      return (0, _webTransactions.startTransaction)(this);
    }
  }, {
    key: "commitTransaction",
    value: function commitTransaction() {
      var readOnly = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
      return (0, _webTransactions.commitTransaction)(this, readOnly);
    }
  }, {
    key: "_beforeRequest",
    value: function () {
      var _beforeRequest2 = _asyncToGenerator(function* () {
        if (!this.initialized) {
          var php = yield this.binary;
          yield this.loadInit(php);
          yield navigator.locks.request('php-wasm-fs-lock', function () {
            return new Promise(function (accept, reject) {
              return php.FS.syncfs(true, function (err) {
                if (err) reject(err);else accept();
              });
            });
          });
        }
        this.initialized = true;
      });
      function _beforeRequest() {
        return _beforeRequest2.apply(this, arguments);
      }
      return _beforeRequest;
    }()
  }, {
    key: "_afterRequest",
    value: function () {
      var _afterRequest2 = _asyncToGenerator(function* () {
        if (this.phpArgs.staticFS) {
          return;
        }
        var php = yield this.binary;
        yield navigator.locks.request('php-wasm-fs-lock', function () {
          return new Promise(function (accept, reject) {
            return php.FS.syncfs(false, function (err) {
              if (err) reject(err);else accept();
            });
          });
        });
      });
      function _afterRequest() {
        return _afterRequest2.apply(this, arguments);
      }
      return _afterRequest;
    }()
  }, {
    key: "refresh",
    value: function refresh() {
      var _this = this;
      var _resolveDependencies = (0, _resolveDependencies2.resolveDependencies)(this.sharedLibs, this),
        files = _resolveDependencies.files,
        libs = _resolveDependencies.libs,
        urlLibs = _resolveDependencies.urlLibs;
      var userLocateFile = this.phpArgs.locateFile || function () {
        return undefined;
      };
      var locateFile = function locateFile(path) {
        var located = userLocateFile(path);
        if (located !== undefined) {
          return located;
        }
        if (urlLibs[path]) {
          return urlLibs[path];
        }
      };
      var phpArgs = _objectSpread(_objectSpread({
        persist: [{
          mountPath: '/persist'
        }, {
          mountPath: '/config'
        }]
      }, this.phpArgs), {}, {
        stdin: function stdin() {
          return _this.input ? String(_this.input.shift()).charCodeAt(0) : null;
        },
        stdout: function stdout(x) {
          return _this.output.push(x);
        },
        stderr: function stderr(x) {
          return _this.error.push(x);
        },
        locateFile: locateFile
      });
      this.binary = navigator.locks.request('php-wasm-fs-lock', /*#__PURE__*/_asyncToGenerator(function* () {
        var php = yield new _this.PHP(phpArgs);
        yield php.ccall('pib_storage_init', NUM, [], [], {
          async: true
        });
        if (!php.FS.analyzePath('/preload').exists) {
          php.FS.mkdir('/preload');
        }
        yield Promise.all(_this.files.concat(files).map(function (fileDef) {
          return php.FS.createPreloadedFile(fileDef.parent, fileDef.name, fileDef.url, true, false);
        }));
        var iniLines = libs.map(function (lib) {
          if (typeof lib === 'string' || lib instanceof URL) {
            return "extension=".concat(lib);
          } else if (_typeof(lib) === 'object' && lib.ini) {
            return "extension=".concat(String(lib.url).split('/').pop());
          }
        });
        _this.phpArgs.ini && iniLines.push(_this.phpArgs.ini.replace(/\n\s+/g, '\n'));
        php.FS.writeFile('/php.ini', iniLines.join("\n") + "\n", {
          encoding: 'utf8'
        });
        yield new Promise(function (accept, reject) {
          php.FS.syncfs(true, function (error) {
            if (error) reject(error);else accept();
          });
        });
        yield php.ccall('wasm_sapi_cgi_init', 'number', [], [], {
          async: true
        });
        var cookieStat = php.FS.analyzePath('/config/.cookies');
        if (cookieStat.exists) {
          _this.cookieJar.load(php.FS.readFile('/config/.cookies', {
            encoding: 'utf8'
          }));
        }
        yield _this.loadInit(php);
        return php;
      }));
    }
  }, {
    key: "_enqueue",
    value: function () {
      var _enqueue2 = _asyncToGenerator(function* (callback) {
        var _this2 = this;
        var params = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
        var readOnly = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
        var accept, reject;
        var coordinator = new Promise(function (a, r) {
          var _ref2;
          return _ref2 = [a, r], accept = _ref2[0], reject = _ref2[1], _ref2;
        });
        this.queue.push([callback, params, accept, reject]);
        navigator.locks.request('php-wasm-fs-lock', /*#__PURE__*/_asyncToGenerator(function* () {
          if (!_this2.queue.length) {
            return;
          }
          yield _this2.autoTransaction ? _this2.startTransaction() : Promise.resolve();
          do {
            var _this2$queue$shift = _this2.queue.shift(),
              _this2$queue$shift2 = _slicedToArray(_this2$queue$shift, 4),
              _callback = _this2$queue$shift2[0],
              _params = _this2$queue$shift2[1],
              _accept = _this2$queue$shift2[2],
              _reject = _this2$queue$shift2[3];
            yield _callback.apply(void 0, _toConsumableArray(_params)).then(_accept)["catch"](_reject);
            var lockChecks = 5;
            while (!_this2.queue.length && lockChecks--) {
              yield new Promise(function (a) {
                return setTimeout(a, 5);
              });
            }
          } while (_this2.queue.length);
          yield _this2.autoTransaction ? _this2.commitTransaction(readOnly) : Promise.resolve();
        }));
        return coordinator;
      });
      function _enqueue(_x) {
        return _enqueue2.apply(this, arguments);
      }
      return _enqueue;
    }()
  }]);
}(_PhpCgiBase2.PhpCgiBase);