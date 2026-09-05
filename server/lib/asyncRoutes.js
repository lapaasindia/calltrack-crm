// Express 4 ignores the promise an `async (req, res)` handler returns, so a
// rejection becomes an unhandledRejection: the request hangs and, on Node ≥ 15
// with no guard, the whole process dies (audit SEC-8 / SCALE-8). This patches
// express's Router Layer (the express-async-errors technique) so that ANY
// handler/middleware returning a promise forwards its rejection to next(err),
// where the JSON error middleware turns it into a 500 with a request id.
//
// It must run before any Router is constructed — app.js imports it first, and
// route modules build their Routers at import time after that.
import Layer from 'express/lib/router/layer.js';

const last = (arr) => arr[arr.length - 1];

function wrap(fn) {
  if (typeof fn !== 'function' || fn.__asyncWrapped) return fn;
  const wrapped = function asyncWrapped(...args) {
    const ret = fn.apply(this, args);
    if (ret && typeof ret.catch === 'function') {
      const next = last(args);
      if (typeof next === 'function') ret.catch((err) => next(err));
    }
    return ret;
  };
  // Express inspects fn.length to tell error handlers (arity 4) from normal ones.
  Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true });
  wrapped.__asyncWrapped = true;
  return wrapped;
}

if (!Layer.prototype.__asyncPatched) {
  Object.defineProperty(Layer.prototype, 'handle', {
    enumerable: true,
    configurable: true,
    get() { return this.__handle; },
    set(fn) { this.__handle = wrap(fn); },
  });
  Object.defineProperty(Layer.prototype, '__asyncPatched', { value: true });
}

// Explicit form for code that prefers it (identical behaviour to the patch).
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
