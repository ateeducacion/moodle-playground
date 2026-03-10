"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.fsOps = void 0;
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
var fsOps = exports.fsOps = /*#__PURE__*/function () {
  function fsOps() {
    _classCallCheck(this, fsOps);
  }
  return _createClass(fsOps, null, [{
    key: "analyzePath",
    value: function () {
      var _analyzePath = _asyncToGenerator(function* (binary, path) {
        var result = (yield binary).FS.analyzePath(path);
        if (!result.object) {
          return {
            exists: false
          };
        }
        var object = {
          exists: true,
          id: result.object.id,
          mode: result.object.mode,
          mount: {
            mountpoint: result.object.mount.mountpoint,
            mounts: result.object.mount.mounts.map(function (m) {
              return m.mountpoint;
            })
          },
          isDevice: result.object.isDevice,
          isFolder: result.object.isFolder,
          read: result.object.read,
          write: result.object.write
        };
        return _objectSpread(_objectSpread({}, result), {}, {
          object: object,
          parentObject: undefined
        });
      });
      function analyzePath(_x, _x2) {
        return _analyzePath.apply(this, arguments);
      }
      return analyzePath;
    }()
  }, {
    key: "readdir",
    value: function () {
      var _readdir = _asyncToGenerator(function* (binary, path) {
        return (yield binary).FS.readdir(path);
      });
      function readdir(_x3, _x4) {
        return _readdir.apply(this, arguments);
      }
      return readdir;
    }()
  }, {
    key: "readFile",
    value: function () {
      var _readFile = _asyncToGenerator(function* (binary, path, options) {
        return (yield binary).FS.readFile(path, options);
      });
      function readFile(_x5, _x6, _x7) {
        return _readFile.apply(this, arguments);
      }
      return readFile;
    }()
  }, {
    key: "stat",
    value: function () {
      var _stat = _asyncToGenerator(function* (binary, path) {
        return (yield binary).FS.stat(path);
      });
      function stat(_x8, _x9) {
        return _stat.apply(this, arguments);
      }
      return stat;
    }()
  }, {
    key: "mkdir",
    value: function () {
      var _mkdir = _asyncToGenerator(function* (binary, path) {
        var php = yield binary;
        var _result = php.FS.mkdir(path);
        return {
          id: _result.id,
          mode: _result.mode,
          mount: {
            mountpoint: _result.mount.mountpoint,
            mounts: _result.mount.mounts.map(function (m) {
              return m.mountpoint;
            })
          },
          isDevice: _result.isDevice,
          isFolder: _result.isFolder,
          read: _result.read,
          write: _result.write
        };
      });
      function mkdir(_x10, _x11) {
        return _mkdir.apply(this, arguments);
      }
      return mkdir;
    }()
  }, {
    key: "rmdir",
    value: function () {
      var _rmdir = _asyncToGenerator(function* (binary, path) {
        return (yield binary).FS.rmdir(path);
      });
      function rmdir(_x12, _x13) {
        return _rmdir.apply(this, arguments);
      }
      return rmdir;
    }()
  }, {
    key: "rename",
    value: function () {
      var _rename = _asyncToGenerator(function* (binary, path, newPath) {
        return (yield binary).FS.rename(path, newPath);
      });
      function rename(_x14, _x15, _x16) {
        return _rename.apply(this, arguments);
      }
      return rename;
    }()
  }, {
    key: "writeFile",
    value: function () {
      var _writeFile = _asyncToGenerator(function* (binary, path, data, options) {
        var bin = yield binary;
        var about = bin.FS.analyzePath(path);
        var forced = false;
        if (about.object && about.object.mode) {
          if (!(about.object.mode & 128)) {
            yield bin.FS.chmod(path, about.object.mode | 128);
          }
        }
        var result = bin.FS.writeFile(path, data, options);
        if (forced) {
          yield bin.FS.chmod(path, about.object.mode);
        }
        return result;
      });
      function writeFile(_x17, _x18, _x19, _x20) {
        return _writeFile.apply(this, arguments);
      }
      return writeFile;
    }()
  }, {
    key: "unlink",
    value: function () {
      var _unlink = _asyncToGenerator(function* (binary, path) {
        return (yield binary).FS.unlink(path);
      });
      function unlink(_x21, _x22) {
        return _unlink.apply(this, arguments);
      }
      return unlink;
    }()
  }, {
    key: "chmod",
    value: function () {
      var _chmod = _asyncToGenerator(function* (binary, mode) {
        return (yield binary).FS.chmod(mode);
      });
      function chmod(_x23, _x24) {
        return _chmod.apply(this, arguments);
      }
      return chmod;
    }()
  }]);
}();