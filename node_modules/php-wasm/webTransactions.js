"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.commitTransaction = commitTransaction;
exports.startTransaction = startTransaction;
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
function startTransaction(_x) {
  return _startTransaction.apply(this, arguments);
}
function _startTransaction() {
  _startTransaction = _asyncToGenerator(function* (wrapper) {
    var php = yield wrapper.binary;
    if (wrapper.transactionStarted || !php.persist) {
      return wrapper.transactionStarted;
    }
    wrapper.transactionStarted = new Promise(function (accept, reject) {
      return php.FS.syncfs(true, function (error) {
        if (error) {
          reject(error);
        } else {
          accept();
        }
      });
    });
    return yield wrapper.transactionStarted;
  });
  return _startTransaction.apply(this, arguments);
}
function commitTransaction(_x2) {
  return _commitTransaction.apply(this, arguments);
}
function _commitTransaction() {
  _commitTransaction = _asyncToGenerator(function* (wrapper) {
    var readOnly = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;
    var php = yield wrapper.binary;
    if (!php.persist) {
      return;
    }
    if (!wrapper.transactionStarted) {
      throw new Error('No transaction initialized.');
    }
    if (readOnly) {
      wrapper.transactionStarted = false;
      return Promise.resolve();
    }
    return yield new Promise(function (accept, reject) {
      return php.FS.syncfs(false, function (error) {
        if (error) {
          reject(error);
        } else {
          wrapper.transactionStarted = false;
          accept();
        }
      });
    });
  });
  return _commitTransaction.apply(this, arguments);
}